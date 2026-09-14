//! MQLens Server errors, rendered in the desktop's error style.
//!
//! Commands return `Result<_, String>` and the UI shows that string, so a gRPC
//! status becomes one sentence. Refusals that come from the server itself
//! (sign-in, permission, availability) name MQLens Server, so a user can tell
//! them apart from a MongoDB error the server passed along. Every message
//! carries the server's correlation id when there is one: that id finds the
//! request in the server's audit log.

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
        Code::Cancelled => "The request to MQLens Server was cancelled".to_string(),
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
    use tonic::metadata::MetadataValue;

    fn with_id(mut status: Status, id: &str) -> Status {
        status
            .metadata_mut()
            .insert(CORRELATION_KEY, MetadataValue::try_from(id).unwrap());
        status
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

    #[test]
    fn unauthenticated_is_recognised() {
        assert!(is_unauthenticated(&Status::unauthenticated("")));
        assert!(!is_unauthenticated(&Status::permission_denied("")));
    }
}
