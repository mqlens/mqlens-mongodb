//! MQLens Server errors, rendered in the desktop's error style.
//!
//! Commands return `Result<_, String>` and the UI shows that string, so a gRPC
//! status becomes one sentence. Refusals that come from the server itself
//! (sign-in, permission, availability) name MQLens Server, so a user can tell
//! them apart from a MongoDB error the server passed along. Every message
//! carries the server's correlation id when there is one: that id finds the
//! request in the server's audit log.

use std::error::Error;
use tonic::{Code, Status};

/// The metadata key the server sends its correlation id under. gRPC metadata
/// keys are lowercase on the wire; the server spells it `X-Correlation-Id`.
pub(crate) const CORRELATION_KEY: &str = "x-correlation-id";

/// Longest correlation id worth showing. The server's ids are far shorter; a
/// longer value is not one of them and is left out rather than echoed.
const MAX_CORRELATION_ID_LEN: usize = 128;

/// The user-facing message for a status returned by MQLens Server.
pub(crate) fn describe(status: &Status) -> String {
    let message = status.message().trim();
    let text = match status.code() {
        Code::Unauthenticated => format!("MQLens Server sign-in is required{}", detail(message)),
        Code::PermissionDenied => {
            format!(
                "MQLens Server did not permit this operation{}",
                detail(message)
            )
        }
        Code::Unavailable => format!("MQLens Server is unavailable{}", detail(message)),
        Code::DeadlineExceeded => {
            format!("MQLens Server did not answer in time{}", detail(message))
        }
        Code::Unimplemented => format!(
            "This MQLens Server does not support this operation{}",
            detail(message)
        ),
        // tonic reports its own client-side deadline as Cancelled.
        Code::Cancelled if deadline_expired(status) => {
            with_detail("MQLens Server did not answer in time", "")
        }
        Code::Cancelled => "The request to MQLens Server was cancelled".to_string(),
        // A killed node sends no status: the proxy in front of it resets the
        // stream. The code tonic picks for that depends on its features, so only
        // the reset itself tells this from an error the server sent.
        _ if stream_reset(status) => "MQLens Server is unavailable".to_string(),
        code if message.is_empty() => format!("MQLens Server error: {}", code.description()),
        _ => message.to_string(),
    };
    with_correlation(text, status)
}

/// `text`, followed by the server's correlation id when the status carries one.
pub(crate) fn with_correlation(text: String, status: &Status) -> String {
    match correlation_id(status) {
        Some(id) => format!("{text} (MQLens Server correlation id: {id})"),
        None => text,
    }
}

/// The correlation id the server attached to a status, if it is one worth
/// showing: printable ASCII, no spaces, and of a sane length.
pub(crate) fn correlation_id(status: &Status) -> Option<String> {
    let id = status
        .metadata()
        .get(CORRELATION_KEY)?
        .to_str()
        .ok()?
        .trim();
    let plausible = !id.is_empty()
        && id.len() <= MAX_CORRELATION_ID_LEN
        && id.chars().all(|c| c.is_ascii_graphic());
    plausible.then(|| id.to_string())
}

/// True when the server refused the call because the session is not signed in
/// or its access token is no longer accepted.
pub(crate) fn is_unauthenticated(status: &Status) -> bool {
    status.code() == Code::Unauthenticated
}

/// The errors under a status. On a real call the cause sits under transport
/// errors, so what it was takes the whole source chain to find out.
fn sources(status: &Status) -> impl Iterator<Item = &(dyn Error + 'static)> {
    std::iter::successors(Error::source(status), |error| (*error).source())
}

/// Whether the status is tonic reporting its own expired deadline.
fn deadline_expired(status: &Status) -> bool {
    sources(status).any(|error| error.is::<tonic::TimeoutExpired>())
}

/// Whether the call ended because HTTP/2 reset its stream.
fn stream_reset(status: &Status) -> bool {
    sources(status)
        .filter_map(|error| error.downcast_ref::<h2::Error>())
        .any(h2::Error::is_reset)
}

fn with_detail(text: &str, message: &str) -> String {
    format!("{text}{}", detail(message))
}

fn detail(message: &str) -> String {
    if message.is_empty() {
        String::new()
    } else {
        format!(": {message}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::channel::client;
    use crate::server::fake::{Env, PASSWORD};
    use crate::server::pb::mqlens::v1::data_service_client::DataServiceClient;
    use crate::server::pb::mqlens::v1::FindRequest;
    use crate::server::session::AccountSession;
    use std::sync::Arc;
    use tonic::metadata::MetadataValue;

    fn with_id(mut status: Status, id: &str) -> Status {
        status
            .metadata_mut()
            .insert(CORRELATION_KEY, MetadataValue::try_from(id).unwrap());
        status
    }

    /// What a client gets when the node behind the proxy is killed mid-Find: a
    /// real RST_STREAM on a real connection, after the first batch got through.
    /// `h2` has no public way to build such an error by hand.
    async fn reset_mid_stream() -> Status {
        let env = Env::new().await;
        env.fake.with(|s| {
            s.documents = (0..3).map(|i| mongodb::bson::doc! { "_id": i }).collect();
            s.batch_size = 1;
            s.find_killed = true;
        });
        let session = match AccountSession::sign_in(&env.account, PASSWORD, env.store()).await {
            Ok(session) => session,
            Err(e) => panic!("sign in failed: {e}"),
        };
        let request = FindRequest {
            connection_id: "c1".to_string(),
            ..Default::default()
        };
        let mut stream = session
            .open_stream(request, |channel, request| async move {
                client!(DataServiceClient, channel).find(request).await
            })
            .await
            .unwrap();
        assert!(matches!(stream.message().await, Ok(Some(_))));
        stream.message().await.unwrap_err()
    }

    #[tokio::test]
    async fn a_reset_stream_reads_as_an_unavailable_server() {
        assert_eq!(
            describe(&reset_mid_stream().await),
            "MQLens Server is unavailable"
        );
    }

    // `cargo test` switches on tonic's `server` feature, which turns this reset
    // into Internal. The app is built without it, and there the same reset is
    // Unknown, so the code says nothing either way.
    #[tokio::test]
    async fn a_reset_stream_reads_the_same_without_the_server_feature() {
        let mut status = Status::unknown("error reading a body from connection");
        status.set_source(Arc::new(reset_mid_stream().await));
        assert_eq!(describe(&status), "MQLens Server is unavailable");
    }

    #[tokio::test]
    async fn a_reset_stream_keeps_the_correlation_id() {
        assert_eq!(
            describe(&with_id(reset_mid_stream().await, "corr-7")),
            "MQLens Server is unavailable (MQLens Server correlation id: corr-7)"
        );
    }

    #[test]
    fn server_refusals_name_mqlens_server() {
        let cases = [
            (
                Status::unauthenticated("token expired"),
                "MQLens Server sign-in is required: token expired",
            ),
            (
                Status::permission_denied("no grant"),
                "MQLens Server did not permit this operation: no grant",
            ),
            (
                Status::unavailable("tcp connect error"),
                "MQLens Server is unavailable: tcp connect error",
            ),
            (
                Status::deadline_exceeded(""),
                "MQLens Server did not answer in time",
            ),
            (
                Status::unimplemented(""),
                "This MQLens Server does not support this operation",
            ),
            (
                Status::cancelled("client went away"),
                "The request to MQLens Server was cancelled",
            ),
        ];
        for (status, want) in cases {
            assert_eq!(describe(&status), want, "for {:?}", status.code());
        }
    }

    #[test]
    fn other_codes_pass_the_server_message_through() {
        assert_eq!(
            describe(&Status::invalid_argument("  unknown operator: $foo  ")),
            "unknown operator: $foo"
        );
        assert_eq!(
            describe(&Status::not_found("collection not found")),
            "collection not found"
        );
        assert_eq!(
            describe(&Status::internal("cursor state corrupted")),
            "cursor state corrupted"
        );
        assert_eq!(
            describe(&Status::unknown("unrecognized mongosh reply")),
            "unrecognized mongosh reply"
        );
    }

    #[test]
    fn an_empty_message_falls_back_to_the_code() {
        assert_eq!(
            describe(&Status::internal("")),
            format!("MQLens Server error: {}", Code::Internal.description())
        );
    }

    #[test]
    fn the_correlation_id_is_appended() {
        let status = with_id(Status::permission_denied("no grant"), "01J9ZK3Q8R");
        assert_eq!(
            describe(&status),
            "MQLens Server did not permit this operation: no grant (MQLens Server correlation id: 01J9ZK3Q8R)"
        );
        assert_eq!(correlation_id(&status).as_deref(), Some("01J9ZK3Q8R"));
    }

    #[test]
    fn implausible_correlation_ids_are_left_out() {
        for id in [
            "",
            "   ",
            "has space",
            &"x".repeat(MAX_CORRELATION_ID_LEN + 1),
        ] {
            let status = with_id(Status::not_found("gone"), id);
            assert_eq!(correlation_id(&status), None, "id {id:?}");
            assert_eq!(describe(&status), "gone");
        }
        let longest = "x".repeat(MAX_CORRELATION_ID_LEN);
        assert_eq!(
            correlation_id(&with_id(Status::not_found("gone"), &longest)),
            Some(longest)
        );
    }

    #[test]
    fn any_message_can_carry_the_correlation_id() {
        let status = with_id(Status::unauthenticated("invalid login"), "corr-7");
        assert_eq!(
            with_correlation("Sign in again.".to_string(), &status),
            "Sign in again. (MQLens Server correlation id: corr-7)"
        );
        assert_eq!(
            with_correlation("Sign in again.".to_string(), &Status::unauthenticated("")),
            "Sign in again."
        );
    }

    // tonic reports its own client-side deadline as Cancelled; it is a server
    // that did not answer, not a request anyone cancelled.
    #[test]
    fn an_expired_deadline_reads_as_no_answer() {
        let status = Status::from_error(Box::new(tonic::TimeoutExpired(())));
        assert_eq!(status.code(), Code::Cancelled);
        assert_eq!(describe(&status), "MQLens Server did not answer in time");
    }

    #[test]
    fn unauthenticated_is_recognised() {
        assert!(is_unauthenticated(&Status::unauthenticated("")));
        assert!(!is_unauthenticated(&Status::permission_denied("")));
    }
}
