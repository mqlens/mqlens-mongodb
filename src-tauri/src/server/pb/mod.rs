//! Generated MQLens Server protobuf messages and gRPC clients.
//!
//! Everything under this directory except this file is generated from
//! `proto/` by `scripts/refresh-server-protos.sh`; do not edit it by hand. The
//! server halves are compiled only for tests, where they back the fake server.

#[allow(clippy::all, clippy::pedantic, dead_code, unused_imports)]
pub mod mqlens {
    pub mod v1 {
        include!("mqlens/v1/mqlens.v1.rs");
    }
}
