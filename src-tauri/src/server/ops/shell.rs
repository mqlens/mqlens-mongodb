//! The MongoDB shell on a server connection: mongosh runs on MQLens Server,
//! and this end hands the session code the pipes a spawned mongosh would
//! have, so everything above them is local mode's.

use crate::server::channel::client;
use crate::server::errors;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::shell_service_client::ShellServiceClient;
use crate::server::pb::mqlens::v1::MongoshClientMsg;
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::AppState;
use futures::StreamExt;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

/// What each pipe between the session code and the server's stream holds.
const PIPE: usize = 64 * 1024;

/// The server's shell, held where a local session holds its child: stopping
/// it ends the stream, and with it mongosh on the server.
pub(crate) struct RemoteShell {
    pump: tokio::task::JoinHandle<()>,
    failure: Arc<Mutex<Option<String>>>,
}

impl RemoteShell {
    pub(crate) fn stop(&self) {
        self.pump.abort();
    }

    /// The server's error, when its stream ended with one.
    pub(crate) fn failure(&self) -> Option<String> {
        self.failure.lock().ok()?.clone()
    }
}

/// A started shell: its stdin, stdout and stderr, as a child's would be.
pub(crate) struct Shell {
    pub(crate) stdin: DuplexStream,
    pub(crate) stdout: DuplexStream,
    pub(crate) stderr: DuplexStream,
    pub(crate) process: RemoteShell,
}

/// What the shell is sent: its first message, then whatever is written to its
/// stdin. Cloned only to retry the opening after a refresh, before any input.
#[derive(Clone)]
struct Input {
    first: MongoshClientMsg,
    stdin: Arc<tokio::sync::Mutex<DuplexStream>>,
}

fn messages(input: Input) -> impl futures::Stream<Item = MongoshClientMsg> + Send + 'static {
    let rest = futures::stream::unfold(input.stdin, |stdin| async move {
        let mut buf = vec![0u8; PIPE];
        let read = stdin.lock().await.read(&mut buf).await.ok()?;
        if read == 0 {
            return None;
        }
        buf.truncate(read);
        let message = MongoshClientMsg {
            input: buf.into(),
            ..Default::default()
        };
        Some((message, stdin))
    });
    futures::stream::once(async move { input.first }).chain(rest)
}

/// Starts mongosh on the server for this connection, with its stderr kept
/// apart as a child's is.
pub(crate) async fn open(state: &AppState, conn: &RemoteConn) -> Result<Shell, String> {
    routes::require("start_mongosh_session", conn)?;
    let (stdin, input) = tokio::io::duplex(PIPE);
    let input = Input {
        first: MongoshClientMsg {
            connection_id: conn.remote_id.clone(),
            separate_stderr: true,
            ..Default::default()
        },
        stdin: Arc::new(tokio::sync::Mutex::new(input)),
    };
    let mut output = session_for(state, conn)
        .await?
        .open_stream(input, |channel, request| async move {
            client!(ShellServiceClient, channel)
                .mongosh_session(request.map(messages))
                .await
        })
        .await?;
    let (mut stdout_in, stdout) = tokio::io::duplex(PIPE);
    let (mut stderr_in, stderr) = tokio::io::duplex(PIPE);
    let failure = Arc::new(Mutex::new(None));
    let failed = failure.clone();
    // No idle limit: a shell waits on its user. When the server ends the
    // stream, the writers drop, which the session reads as mongosh exiting;
    // an error it ended with is kept first, for the session to report.
    let pump = tokio::spawn(async move {
        loop {
            let message = match output.message().await {
                Ok(Some(message)) => message,
                Ok(None) => break,
                Err(status) => {
                    if let Ok(mut failed) = failed.lock() {
                        *failed = Some(errors::describe(&status));
                    }
                    break;
                }
            };
            if stdout_in.write_all(&message.output).await.is_err()
                || stderr_in.write_all(&message.stderr).await.is_err()
            {
                break;
            }
        }
    });
    Ok(Shell {
        stdin,
        stdout,
        stderr,
        process: RemoteShell { pump, failure },
    })
}

#[cfg(test)]
mod tests {
    use crate::server::fake::Env;
    use crate::server::ops::connected;
    use crate::{
        run_mongosh_command_impl, run_mongosh_script_impl, start_mongosh_session_impl,
        stop_mongosh_session_impl, AppState, MongoshCommandOutput,
    };

    async fn admin(env: &Env) -> (crate::AppState, String) {
        env.fake.with(|s| {
            s.connections[0].op_classes =
                vec!["read".to_string(), "write".to_string(), "admin".to_string()]
        });
        connected(env).await
    }

    async fn ended(env: &Env, count: u32) -> bool {
        for _ in 0..100 {
            if env.fake.with(|s| s.shells_ended) >= count {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        false
    }

    // A shell on a server connection runs on the server: it asks for stderr
    // apart, starts in the tab's database, and each command comes back as
    // local mode reports it.
    #[tokio::test]
    async fn a_shell_runs_its_commands_on_the_server() {
        let env = Env::new().await;
        let (state, id) = admin(&env).await;

        let info = start_mongosh_session_impl(&state, &id, "", "orders", "", "")
            .await
            .unwrap();
        let first = env.fake.with(|s| s.shells[0].clone());
        assert_eq!(first.connection_id, "c1");
        assert!(first.separate_stderr);

        let out = run_mongosh_command_impl(&state, &info.session_id, "db.customers.find()")
            .await
            .unwrap();
        assert_eq!(out.stdout, ["ran db.customers.find()"]);
        assert!(out.stderr.is_empty());
        let sent = env.fake.with(|s| s.shell_input.clone());
        assert_eq!(sent.first().map(String::as_str), Some("use orders"));
        assert!(sent.iter().any(|l| l == "db.customers.find()"));
    }

    /// A script on the tab's shell, as MongoShell runs one.
    async fn script(
        state: &AppState,
        id: &str,
        session: &str,
        script: &str,
    ) -> Result<MongoshCommandOutput, String> {
        run_mongosh_script_impl(state, id, "", "orders", "", script, Some(session)).await
    }

    async fn shell(env: &Env) -> (AppState, String, String) {
        let (state, id) = admin(env).await;
        let session = start_mongosh_session_impl(&state, &id, "", "orders", "", "")
            .await
            .unwrap()
            .session_id;
        (state, id, session)
    }

    /// The shell still takes commands, and the server never ended it.
    async fn assert_usable(env: &Env, state: &AppState, session: &str) {
        let out = run_mongosh_command_impl(state, session, "db.stats()")
            .await
            .unwrap();
        assert_eq!(out.stdout, ["ran db.stats()"]);
        assert_eq!(env.fake.with(|s| s.shells_ended), 0);
    }

    // A script runs in the tab's shell as one unit: the server's mongosh reads
    // it whole, so no line of it reaches the REPL to be taken for a keyword or
    // to run on its own (#518). The shell is the tab's, not a second process.
    #[tokio::test]
    async fn a_script_runs_in_the_server_shell_as_one_unit() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;
        let text = "db.orders.find()\n  .limit(1)\nprint(2)";

        let out = script(&state, &id, &session, text).await.unwrap();

        assert_eq!(
            out.stdout,
            ["ran db.orders.find()", "ran .limit(1)", "ran print(2)"]
        );
        assert!(out.stderr.is_empty());
        assert_eq!(env.fake.with(|s| s.shell_loaded.clone()), [text]);
        let sent = env.fake.with(|s| s.shell_input.clone());
        assert!(!sent.iter().any(|l| l == "print(2)"), "{sent:?}");
        assert_eq!(env.fake.with(|s| s.shells.len()), 1);
        assert_usable(&env, &state, &session).await;
    }

    // Multi-line input on a server shell is a script however it arrives.
    #[tokio::test]
    async fn a_multi_line_command_on_a_server_shell_runs_as_one_unit_too() {
        let env = Env::new().await;
        let (state, _, session) = shell(&env).await;

        run_mongosh_command_impl(&state, &session, "print(1)\nprint(2)")
            .await
            .unwrap();

        assert_eq!(
            env.fake.with(|s| s.shell_loaded.clone()),
            ["print(1)\nprint(2)"]
        );
    }

    // A long line is quadratic in mongosh's readline: a 1 MiB one never
    // finished. And it ends a line at U+2028 and U+2029, where JSON does not
    // escape them, which would cut the script's string literal in two.
    #[tokio::test]
    async fn a_large_script_reaches_the_server_on_short_lines_intact() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;
        let text = format!(
            "print(\"a\\u2028b\u{2028}c\u{2029}\")\n{}",
            "// é\r\n".repeat(40_000)
        );

        script(&state, &id, &session, &text).await.unwrap();

        assert_eq!(env.fake.with(|s| s.shell_loaded.clone()), [text]);
        let sent = env.fake.with(|s| s.shell_input.clone());
        let longest = sent.iter().map(|l| l.chars().count()).max().unwrap();
        assert!(longest < 64 * 1024, "a line of {longest} characters");
        assert!(sent.iter().all(|l| !l.contains(['\u{2028}', '\u{2029}'])));
    }

    // A script stops at its first throw, says so, and leaves the shell as it was.
    #[tokio::test]
    async fn a_script_that_throws_stops_there_and_keeps_the_shell() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;

        let out = script(&state, &id, &session, "print(1)\nthrow boom\nprint(2)")
            .await
            .unwrap();

        assert_eq!(out.stdout, ["ran print(1)", "Uncaught boom"]);
        assert_usable(&env, &state, &session).await;
    }

    // A file that stopped short must not run as far as it got: its first half
    // is a script nobody wrote. One error for it, however many writes failed.
    #[tokio::test]
    async fn a_script_that_cannot_be_staged_does_not_run() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;
        env.fake.with(|s| s.shell_stage_room = Some(50 * 1024));
        let text = "x".repeat(100 * 1024);

        let out = script(&state, &id, &session, &text).await.unwrap();

        assert_eq!(out.stderr, ["Uncaught Error: ENOSPC"]);
        assert!(out.stdout.is_empty(), "{:?}", out.stdout);
        let sent = env.fake.with(|s| s.shell_input.clone());
        assert!(!sent.iter().any(|l| l.contains("load(")), "{sent:?}");
        assert!(sent.iter().any(|l| l.contains("rmSync(")), "the partial file stayed");
        assert_usable(&env, &state, &session).await;
    }

    // The REPL answers every write, and what a command prints is capped. The
    // report of a late write must not be what the cap drops: nothing else says
    // the file stopped short.
    #[tokio::test]
    async fn a_write_that_fails_late_in_a_large_script_is_still_seen() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;
        let writes = crate::limits::MAX_MONGOSH_LINES + 50;
        let text = "x".repeat(writes * crate::MONGOSH_STAGE_CHUNK);
        env.fake.with(|s| s.shell_stage_room = Some(text.len() - 1));

        let out = script(&state, &id, &session, &text).await.unwrap();

        assert_eq!(out.stderr, ["Uncaught Error: ENOSPC"]);
        assert!(env.fake.with(|s| s.shell_loaded.is_empty()));
        let sent = env.fake.with(|s| s.shell_input.clone());
        assert!(sent.iter().any(|l| l.contains("rmSync(")), "the partial file stayed");
    }

    #[tokio::test]
    async fn a_script_that_does_not_parse_runs_nothing_and_keeps_the_shell() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;

        let out = script(&state, &id, &session, "print(1)\nnot javascript\nprint(2)")
            .await
            .unwrap();

        assert_eq!(out.stdout, ["Uncaught SyntaxError"]);
        assert_usable(&env, &state, &session).await;
    }

    // `quit()` ends a script, as it does a one-shot run. It must not end the
    // tab's shell, with its signed-in session and its `use` state.
    #[tokio::test]
    async fn quit_ends_the_script_and_keeps_the_shell() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;

        let out = script(&state, &id, &session, "print(1)\nquit()\nprint(2)")
            .await
            .unwrap();

        assert_eq!(out.stdout, ["ran print(1)"]);
        assert!(out.stderr.is_empty(), "{:?}", out.stderr);
        assert_usable(&env, &state, &session).await;
    }

    // A script that goes on running ends with the shell, which is what Stop
    // ends: on the server too, and the run comes back rather than hanging.
    #[tokio::test]
    async fn stopping_the_shell_stops_a_running_script() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;
        let state = std::sync::Arc::new(state);
        let running = {
            let (state, session) = (state.clone(), session.clone());
            tokio::spawn(async move {
                script(&state, &id, &session, "print(1)\nsleep()\nprint(2)").await
            })
        };
        for _ in 0..100 {
            if !env.fake.with(|s| s.shell_loaded.is_empty()) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(env.fake.with(|s| s.shell_loaded.len()), 1);

        stop_mongosh_session_impl(&state, &session).await.unwrap();

        let stopped = tokio::time::timeout(std::time::Duration::from_secs(5), running).await;
        let err = stopped.expect("Stop did not end the run").unwrap();
        assert_eq!(err.err().as_deref(), Some("mongosh session closed"));
        assert!(ended(&env, 1).await, "the server's shell kept running");
    }

    // A tab that reopens learns a run has ended by waiting on this lock, so
    // the run keeps it from staging to the end. Handed over in between, the
    // tab would be told the shell is idle with the script still to run, and
    // lose its Stop.
    #[tokio::test]
    async fn a_script_keeps_the_shell_until_it_ends() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;
        let tab = crate::get_mongosh_session(&state, &session).unwrap();
        let held = tab.command_lock.lock().await;

        let running = tokio::spawn(async move {
            script(&state, &id, &session, "print(1)\nprint(2)").await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let reopened = {
            let (tab, fake) = (tab.clone(), env.fake.clone());
            tokio::spawn(async move {
                let _idle = tab.command_lock.lock().await;
                fake.with(|s| s.shell_loaded.len())
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(held);

        assert_eq!(reopened.await.unwrap(), 1, "idle before the script ran");
        running.await.unwrap().unwrap();
    }

    // Recorded as a local script is: what ran, and how it went.
    #[tokio::test]
    async fn a_script_is_audited() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;
        let dir = tempfile::tempdir().unwrap();
        let audit = crate::audit::AuditSession::new(dir.path().join("audit.log.enc"));
        audit.open(rand::random::<[u8; 32]>()).unwrap();
        audit.set_policy(crate::audit::AuditPolicy {
            enabled: true,
            level: crate::audit::AuditLevel::C,
            include_payloads: true,
            retention_days: 30,
        });
        *state.audit.lock().unwrap() = Some(audit);

        script(&state, &id, &session, "print(1)\nprint(2)")
            .await
            .unwrap();

        let guard = state.audit.lock().unwrap();
        let rows = guard
            .as_ref()
            .unwrap()
            .query(&crate::audit::AuditFilter::default())
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].op, "run_mongosh_script");
        assert_eq!(rows[0].connection_id.as_deref(), Some(id.as_str()));
        assert!(rows[0].ok);
    }

    // The guards a shell has, a script has: read-only mode, then the role.
    // Neither reaches the shell, and none of this falls back to a local
    // mongosh, which has no URI to connect to.
    #[tokio::test]
    async fn a_script_is_refused_without_reaching_the_shell() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;
        crate::set_connection_meta_impl(
            &state,
            &id,
            "server:a:c1",
            "Orders",
            false,
            crate::connections::ConnectionMode::ReadOnly,
        )
        .unwrap();
        let refused = script(&state, &id, &session, "print(1)\nprint(2)")
            .await
            .map(|_| ())
            .unwrap_err();
        assert_eq!(refused, crate::write_guard::READ_ONLY_MSG);

        let writer = Env::new().await;
        let (state, id) = connected(&writer).await;
        let refused = script(&state, &id, "no-such-session", "print(1)\nprint(2)")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(refused.contains("admin"), "{refused}");

        assert!(env.fake.with(|s| s.shell_loaded.is_empty()));
        assert!(writer.fake.with(|s| s.shells.is_empty()));
    }

    // Without the tab's shell there is nowhere to run it. Another connection's
    // shell will not do: the guards above were for this one.
    #[tokio::test]
    async fn a_script_needs_a_shell_of_its_own_connection() {
        let env = Env::new().await;
        let (state, id, session) = shell(&env).await;
        let conn = state.server.remote(&id).unwrap().unwrap();
        state
            .server
            .add_remote(crate::server::remote::RemoteConn {
                desktop_id: "other".to_string(),
                account_id: conn.account_id.clone(),
                identity: conn.identity.clone(),
                accounts_path: conn.accounts_path.clone(),
                account_name: conn.account_name.clone(),
                server_url: conn.server_url.clone(),
                remote_id: "c2".to_string(),
                op_classes: conn.op_classes.clone(),
                api_version: conn.api_version,
            })
            .unwrap();
        let text = "print(1)\nprint(2)";

        for (connection, shell) in [(id.as_str(), None), ("other", Some(session.as_str()))] {
            let refused =
                run_mongosh_script_impl(&state, connection, "", "", "no-such-mongosh", text, shell)
                    .await
                    .map(|_| ())
                    .unwrap_err();
            assert_eq!(refused, "mongosh session not found");
        }
        assert!(env.fake.with(|s| s.shell_loaded.is_empty()));
    }

    // What the shell writes to stderr is reported as stderr, as local mode
    // reports a child's.
    #[tokio::test]
    async fn the_shell_errors_come_back_as_stderr() {
        let env = Env::new().await;
        let (state, id) = admin(&env).await;
        let info = start_mongosh_session_impl(&state, &id, "", "", "", "")
            .await
            .unwrap();

        let out = run_mongosh_command_impl(&state, &info.session_id, "throw boom")
            .await
            .unwrap();

        assert_eq!(out.stderr, ["Uncaught boom"]);
        assert!(out.stdout.is_empty());
    }

    // Stopping the shell, as closing its tab or disconnecting does, ends it
    // on the server too.
    #[tokio::test]
    async fn stopping_a_shell_ends_it_on_the_server() {
        let env = Env::new().await;
        let (state, id) = admin(&env).await;
        let info = start_mongosh_session_impl(&state, &id, "", "", "", "")
            .await
            .unwrap();

        stop_mongosh_session_impl(&state, &info.session_id)
            .await
            .unwrap();

        assert!(ended(&env, 1).await, "the server's shell kept running");
        assert!(run_mongosh_command_impl(&state, &info.session_id, "1")
            .await
            .is_err());
    }

    // A shell the server ends, as `quit()` does, reads as a closed session.
    #[tokio::test]
    async fn a_shell_the_server_ends_is_closed() {
        let env = Env::new().await;
        let (state, id) = admin(&env).await;
        let info = start_mongosh_session_impl(&state, &id, "", "", "", "")
            .await
            .unwrap();

        let err = run_mongosh_command_impl(&state, &info.session_id, "quit()")
            .await
            .map(|_| ())
            .unwrap_err();

        assert_eq!(err, "mongosh session closed");
    }

    // A shell the server ends with an error says why, then and on every
    // later command, instead of only that it closed.
    #[tokio::test]
    async fn a_shell_that_fails_on_the_server_says_why() {
        let env = Env::new().await;
        let (state, id) = admin(&env).await;
        let info = start_mongosh_session_impl(&state, &id, "", "", "", "")
            .await
            .unwrap();

        let err = run_mongosh_command_impl(&state, &info.session_id, "fail()")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(err.contains("mongosh crashed"), "{err}");

        let again = run_mongosh_command_impl(&state, &info.session_id, "1")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(again.contains("mongosh crashed"), "{again}");
    }

    // A node killed under a shell takes that mongosh with it, so this session
    // stays closed, for the reason the user can act on, and a new one starts.
    #[tokio::test]
    async fn a_shell_reset_by_the_server_can_be_started_again() {
        let env = Env::new().await;
        let (state, id) = admin(&env).await;
        let info = start_mongosh_session_impl(&state, &id, "", "", "", "")
            .await
            .unwrap();

        let err = run_mongosh_command_impl(&state, &info.session_id, "kill()")
            .await
            .map(|_| ())
            .unwrap_err();
        assert_eq!(err, "mongosh session closed: MQLens Server is unavailable");

        let again = start_mongosh_session_impl(&state, &id, "", "", "", "")
            .await
            .unwrap();
        let out = run_mongosh_command_impl(&state, &again.session_id, "1")
            .await
            .unwrap();
        assert_eq!(out.stdout, ["ran 1"]);
    }

    // A shell that fails as it starts is not reported as started.
    #[tokio::test]
    async fn a_shell_that_fails_to_start_on_the_server_is_not_started() {
        let env = Env::new().await;
        let (state, id) = admin(&env).await;
        env.fake.with(|s| s.shell_start_failure = true);

        let err = start_mongosh_session_impl(&state, &id, "", "orders", "", "")
            .await
            .map(|_| ())
            .unwrap_err();

        assert!(err.contains("connection refused"), "{err}");
        assert!(state.mongosh_sessions.lock().unwrap().is_empty());
    }

    // No shell where local mode would refuse one or the server would: on a
    // read-only connection, or without the admin class.
    #[tokio::test]
    async fn a_shell_is_refused_without_reaching_the_server() {
        let env = Env::new().await;
        let (state, id) = admin(&env).await;
        crate::set_connection_meta_impl(
            &state,
            &id,
            "server:a:c1",
            "Orders",
            false,
            crate::connections::ConnectionMode::ReadOnly,
        )
        .unwrap();
        assert_eq!(
            start_mongosh_session_impl(&state, &id, "", "", "", "")
                .await
                .map(|_| ())
                .unwrap_err(),
            crate::write_guard::READ_ONLY_MSG
        );

        let writer = Env::new().await;
        let (state, id) = connected(&writer).await;
        let err = start_mongosh_session_impl(&state, &id, "", "", "", "")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(err.contains("admin"), "{err}");

        assert!(env.fake.with(|s| s.shells.is_empty()));
        assert!(writer.fake.with(|s| s.shells.is_empty()));
    }
}
