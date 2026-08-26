//! Local operation audit log (#272).
//!
//! Level gating, redaction, and SQLite store. Vault envelope is Task 3.

pub mod envelope;
pub mod level;
pub mod redact;
pub mod store;

pub use envelope::{seal, unseal, AuditSession};
pub use level::{should_record, AuditLevel, OpClass};
pub use redact::{redact_text, truncate_args, MAX_ARGS_BYTES};
pub use store::{AuditEvent, AuditFilter, AuditStore, SCHEMA_VERSION};
