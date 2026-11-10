use std::net::IpAddr;

use keelson_tlsn::policy::{
    Refusal, body_start, check_range, check_request, is_public, object_with,
};

const REQUEST: &[u8] = b"GET /api/products/tempo-3 HTTP/1.1\r\nhost: store.keelson.finance\r\naccept: application/json\r\naccept-encoding: identity\r\nconnection: close\r\nuser-agent: keelson-prover/0.0.0\r\n\r\n";

#[test]
fn a_public_get_names_its_target() {
    assert_eq!(
        check_request(REQUEST, "store.keelson.finance"),
        Ok("/api/products/tempo-3".into())
    );
}

#[test]
fn the_host_must_be_the_server_name() {
    assert_eq!(
        check_request(REQUEST, "evil.example"),
        Err(Refusal::Request)
    );
    let twice = b"GET / HTTP/1.1\r\nhost: a.example\r\nhost: a.example\r\n\r\n";
    assert_eq!(check_request(twice, "a.example"), Err(Refusal::Request));
    let none = b"GET / HTTP/1.1\r\naccept: */*\r\n\r\n";
    assert_eq!(check_request(none, "a.example"), Err(Refusal::Request));
}

#[test]
fn credentials_and_other_methods_are_refused() {
    for request in [
        &b"GET / HTTP/1.1\r\nhost: a.example\r\ncookie: s=1\r\n\r\n"[..],
        b"GET / HTTP/1.1\r\nhost: a.example\r\nauthorization: Bearer x\r\n\r\n",
        b"POST / HTTP/1.1\r\nhost: a.example\r\n\r\n",
        b"GET / HTTP/1.1\r\nhost: a.example\r\n\r\nbody",
        b"GET / HTTP/1.1\r\nhost: a.example\r\naccept-encoding: gzip\r\n\r\n",
        b"GET http://a.example/ HTTP/1.1\r\nhost: a.example\r\n\r\n",
        b"GET / HTTP/1.0\r\nhost: a.example\r\n\r\n",
    ] {
        assert_eq!(check_request(request, "a.example"), Err(Refusal::Request));
    }
}

#[test]
fn the_body_starts_after_the_headers_of_a_200() {
    let response = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}";
    assert_eq!(body_start(response), Ok(response.len() - 2));
    assert_eq!(
        body_start(b"HTTP/1.1 404 Not Found\r\n\r\n"),
        Err(Refusal::Response)
    );
    assert_eq!(
        body_start(b"HTTP/1.1 200 OK\r\nx: y"),
        Err(Refusal::Response)
    );
}

#[test]
fn the_range_lies_in_the_body() {
    assert_eq!(check_range(&(10..20), 10, 20), Ok(()));
    assert_eq!(check_range(&(9..20), 10, 20), Err(Refusal::Commitment));
    assert_eq!(check_range(&(10..21), 10, 20), Err(Refusal::Commitment));
    assert_eq!(check_range(&(12..12), 10, 20), Err(Refusal::Commitment));
}

#[test]
fn the_anchor_selects_its_enclosing_object() {
    let body = br#"{"title":"T {x}","variants":[{"id":1,"option1":"9","price":"95.00"},{"id":2,"option1":"10","note":"}","available":true}]}"#;
    let r = object_with(body, br#""id":2"#).unwrap();
    assert_eq!(
        &body[r],
        br#"{"id":2,"option1":"10","note":"}","available":true}"#
    );
    let r = object_with(body, br#""title""#).unwrap();
    assert_eq!(r, 0..body.len());
    assert_eq!(object_with(body, br#""id":3"#), None);
    assert_eq!(object_with(b"[1,2]", b"2"), None);
}

#[test]
fn only_public_addresses_are_dialed() {
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "fc00::1",
        "fe80::1",
        "::ffff:10.0.0.1",
    ] {
        assert!(!is_public(ip.parse::<IpAddr>().unwrap()), "{ip}");
    }
    for ip in ["216.24.57.1", "2606:4700::6810:84e5"] {
        assert!(is_public(ip.parse::<IpAddr>().unwrap()), "{ip}");
    }
}
