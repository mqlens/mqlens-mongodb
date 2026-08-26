//! Local operation audit log (#272).
//!
//! Level gating and redaction live here; SQLite store and vault envelope
//! land in follow-up tasks.

pub mod level;
pub mod redact;

pub use level::{should_record, AuditLevel, OpClass};
pub use redact::{redact_text, truncate_args, MAX_ARGS_BYTES};
