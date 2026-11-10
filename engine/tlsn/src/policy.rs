//! What the notary accepts from a session: a public `GET` whose request it sees in full, a
//! `200` response whose status line and headers it sees, and one SHA-256 commitment to a
//! contiguous range of the response body.

use std::net::IpAddr;
use std::ops::Range;

/// Most bytes the prover may send to the server.
pub const MAX_SENT: usize = 1 << 10;
/// Most bytes the prover may receive from the server.
pub const MAX_RECV: usize = 1 << 14;
/// Longest request target, in bytes.
pub const MAX_PATH: usize = 1024;
/// Most TLS records the prover may send in MPC-TLS.
pub const MAX_SENT_RECORDS: usize = 8;
/// Most TLS records the prover may receive while the session is online in MPC-TLS.
pub const MAX_RECV_RECORDS_ONLINE: usize = 32;

/// Request headers a public `GET` may carry; anything else (cookies, credentials) is refused.
const ALLOWED_HEADERS: [&str; 5] = [
    "host",
    "accept",
    "accept-encoding",
    "connection",
    "user-agent",
];

/// Why the notary refused a session. The codes are stable.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Refusal {
    #[error("request")]
    Request,
    #[error("response")]
    Response,
    #[error("commitment")]
    Commitment,
    #[error("server")]
    Server,
}

/// Checks that `sent` is one `GET` for `server_name` with no body and only the headers of a
/// public request, and returns its target (path and query).
pub fn check_request(sent: &[u8], server_name: &str) -> Result<String, Refusal> {
    let text = std::str::from_utf8(sent).map_err(|_| Refusal::Request)?;
    let head = text.strip_suffix("\r\n\r\n").ok_or(Refusal::Request)?;
    let mut lines = head.split("\r\n");
    // A bare CR or LF would let a lenient server read a second request or a hidden header.
    if head
        .split("\r\n")
        .any(|l| l.bytes().any(|b| (b < 0x20 && b != b'\t') || b == 0x7f))
    {
        return Err(Refusal::Request);
    }
    let target = lines
        .next()
        .and_then(|l| l.strip_prefix("GET "))
        .and_then(|l| l.strip_suffix(" HTTP/1.1"))
        .filter(|t| t.starts_with('/') && t.len() <= MAX_PATH)
        .filter(|t| t.bytes().all(|b| b.is_ascii_graphic()))
        .ok_or(Refusal::Request)?;
    let mut hosts = 0;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(Refusal::Request)?;
        if name.is_empty() || !name.bytes().all(is_token) {
            return Err(Refusal::Request);
        }
        let name = name.to_ascii_lowercase();
        if !ALLOWED_HEADERS.contains(&name.as_str()) {
            return Err(Refusal::Request);
        }
        let value = value.trim();
        match name.as_str() {
            "host" if value.eq_ignore_ascii_case(server_name) => hosts += 1,
            "host" => return Err(Refusal::Request),
            "accept-encoding" if !value.eq_ignore_ascii_case("identity") => {
                return Err(Refusal::Request);
            }
            _ => {}
        }
    }
    if hosts != 1 {
        return Err(Refusal::Request);
    }
    Ok(target.to_owned())
}

/// RFC 9110 `tchar`.
fn is_token(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

/// Where the body starts in a response whose status line and headers the prover revealed, the
/// `revealed` bytes from offset 0. The status must be `200`.
pub fn body_start(revealed: &[u8]) -> Result<usize, Refusal> {
    if !revealed.starts_with(b"HTTP/1.1 200 ") {
        return Err(Refusal::Response);
    }
    revealed
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|p| p + 4)
        .ok_or(Refusal::Response)
}

/// Checks that the committed range lies in the body: after `body_start`, inside a response of
/// `received_len` bytes, and not empty.
pub fn check_range(
    range: &Range<usize>,
    body_start: usize,
    received_len: usize,
) -> Result<(), Refusal> {
    if range.start < body_start || range.end > received_len || range.is_empty() {
        return Err(Refusal::Commitment);
    }
    Ok(())
}

/// The smallest JSON object in `body` that contains `anchor`, as a range of `body`. Strings are
/// skipped, so braces inside them do not count.
pub fn object_with(body: &[u8], anchor: &[u8]) -> Option<Range<usize>> {
    let at = body
        .windows(anchor.len().max(1))
        .position(|w| w == anchor)?;
    let mut opened = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    let mut enclosing = None;
    for (i, &b) in body.iter().enumerate() {
        if i == at {
            enclosing = Some(opened.len());
        }
        if in_string {
            match (escaped, b) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => opened.push(i),
            b'}' => {
                let start = opened.pop()?;
                if let Some(depth) = enclosing
                    && opened.len() + 1 == depth
                    && i >= at + anchor.len()
                {
                    return Some(start..i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Whether `ip` may be dialed from the notary: public unicast addresses only, so a session cannot
/// reach the TEE host's own network.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0)
                || (a == 198 && (18..20).contains(&b))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let s = v6.segments();
            // IPv4-compatible, NAT64, 6to4 and Teredo addresses embed an IPv4 address.
            let embeds_v4 = s[..6] == [0; 6]
                || s[..6] == [0x64, 0xff9b, 0, 0, 0, 0]
                || s[0] == 0x2002
                || (s[0] == 0x2001 && s[1] == 0);
            !(embeds_v4
                || v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || s[0] == 0x2001 && s[1] == 0x0db8)
        }
    }
}
