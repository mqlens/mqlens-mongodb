//! Local operation audit log (#272).
//!
//! Level gating, redaction, and SQLite store. Vault envelope is Task 3.

pub mod level;
pub mod redact;
pub mod store;

pub use level::{should_record, AuditLevel, OpClass};
pub use redact::{redact_text, truncate_args, MAX_ARGS_BYTES};
pub use store::{AuditEvent, AuditFilter, AuditStore, SCHEMA_VERSION};
