//! Audit logging level gate (#272).
//!
//! Decides whether an operation class is recorded at the configured
//! [`AuditLevel`].

/// User-selectable audit verbosity (Settings → Activity / Audit).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuditLevel {
    /// Writes + mongosh (default).
    A,
    /// A + high-level reads (find/aggregate/count/explain/list summaries).
    B,
    /// All DB-facing commands (READ ∪ GUARDED_WRITE) + mongosh.
    C,
}

impl AuditLevel {
    pub fn parse(s: &str) -> Self {
        match s.trim() {
            "B" | "b" => Self::B,
            "C" | "c" => Self::C,
            _ => Self::A,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::B => "B",
            Self::C => "C",
        }
    }
}

/// Coarse class of a MongoDB-facing operation for level gating.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpClass {
    /// Insert/update/delete/drop/rename/import/restore/generate/$out/$merge, etc.
    Write,
    /// Embedded mongosh command text.
    Shell,
    /// find / aggregate (read) / count / explain / namespace list-shaped reads.
    ReadHigh,
    /// Other DB reads covered only at level C (stats, profiler read, etc.).
    ReadOther,
}

/// Returns true when `op` should be persisted at the given settings level.
pub fn should_record(level: AuditLevel, op: OpClass) -> bool {
    match level {
        AuditLevel::A => matches!(op, OpClass::Write | OpClass::Shell),
        AuditLevel::B => matches!(
            op,
            OpClass::Write | OpClass::Shell | OpClass::ReadHigh
        ),
        AuditLevel::C => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_a_records_writes_and_shell_skips_find() {
        assert!(should_record(AuditLevel::A, OpClass::Write));
        assert!(should_record(AuditLevel::A, OpClass::Shell));
        assert!(!should_record(AuditLevel::A, OpClass::ReadHigh));
        assert!(!should_record(AuditLevel::A, OpClass::ReadOther));
    }

    #[test]
    fn level_b_includes_high_reads() {
        assert!(should_record(AuditLevel::B, OpClass::Write));
        assert!(should_record(AuditLevel::B, OpClass::Shell));
        assert!(should_record(AuditLevel::B, OpClass::ReadHigh));
        assert!(!should_record(AuditLevel::B, OpClass::ReadOther));
    }

    #[test]
    fn level_c_includes_all_db_ops() {
        assert!(should_record(AuditLevel::C, OpClass::Write));
        assert!(should_record(AuditLevel::C, OpClass::Shell));
        assert!(should_record(AuditLevel::C, OpClass::ReadHigh));
        assert!(should_record(AuditLevel::C, OpClass::ReadOther));
    }

    #[test]
    fn parse_level_defaults_unknown_to_a() {
        assert_eq!(AuditLevel::parse("A"), AuditLevel::A);
        assert_eq!(AuditLevel::parse("b"), AuditLevel::B);
        assert_eq!(AuditLevel::parse("C"), AuditLevel::C);
        assert_eq!(AuditLevel::parse("nope"), AuditLevel::A);
        assert_eq!(AuditLevel::A.as_str(), "A");
    }
}
