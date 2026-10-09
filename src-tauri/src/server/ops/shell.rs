//! The MongoDB shell on a server connection: mongosh runs on MQLens Server,
//! and this end hands the session code the pipes a spawned mongosh would
//! have, so everything above them is local mode's.

use crate::server::channel::client;
use crate::server::ops::session_for;
use crate::server::pb::mqlens::v1::shell_service_client::ShellServiceClient;
use crate::server::pb::mqlens::v1::MongoshClientMsg;
use crate::server::remote::RemoteConn;
use crate::server::routes;
use crate::AppState;
use futures::StreamExt;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

/// What each pipe between the session code and the server's stream holds.
const PIPE: usize = 64 * 1024;

/// The server's shell, held where a local session holds its child: stopping
/// it ends the stream, and with it mongosh on the server.
pub(crate) struct RemoteShell(tokio::task::JoinHandle<()>);

impl RemoteShell {
    pub(crate) fn stop(&self) {
        self.0.abort();
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
    // No idle limit: a shell waits on its user. When the server ends the
    // stream, the writers drop, which the session reads as mongosh exiting.
    let pump = tokio::spawn(async move {
        while let Ok(Some(message)) = output.message().await {
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
        process: RemoteShell(pump),
    })
}

#[cfg(test)]
mod tests {
    use crate::server::fake::Env;
    use crate::server::ops::connected;
    use crate::{run_mongosh_command_impl, start_mongosh_session_impl, stop_mongosh_session_impl};

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
