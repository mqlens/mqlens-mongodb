//! Server mode: running commands through an MQLens Server instead of a direct
//! MongoDB connection.
//!
//! A desktop user signs in to an MQLens Server account and connects to one of
//! the server's connections. The server holds the connection string and
//! credentials; the desktop only ever sees a connection reference. Local mode
//! does not go through this module.

// The foundation lands before the commands that use it; until server mode is
// routed (accounts, sessions, remote connections), only tests reach it.
#![cfg_attr(not(test), allow(dead_code, unused_macros))]

pub(crate) mod channel;
pub(crate) mod ejson;
pub(crate) mod errors;
pub(crate) mod pb;
