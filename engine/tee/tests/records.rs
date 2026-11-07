mod common;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use keelson_tee::{Engine, EngineError, FileRecords, UserRecords};

use common::*;

struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("keelson-records-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        Self(path)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn engine(records: FileRecords) -> Engine {
    Engine::booted_at(config(None), Some(root()), at(NOW)).with_user_records(Arc::new(records))
}

#[test]
fn a_record_is_stored_once_and_read_back() {
    let dir = Dir::new("once");
    let records = FileRecords::open(&dir.0).unwrap();
    assert_eq!(records.get("sub"), None);
    assert!(records.insert_new("sub", vec![1, 2, 3]));
    assert!(!records.insert_new("sub", vec![9]));
    assert_eq!(records.get("sub"), Some(vec![1, 2, 3]));
    assert_eq!(records.get("hold\0mid"), None);
}

#[test]
fn records_survive_a_restart() {
    let dir = Dir::new("restart");
    let first = engine(FileRecords::open(&dir.0).unwrap());
    first
        .register_mandate(&register_request(), at(NOW))
        .unwrap();

    let restarted = engine(FileRecords::open(&dir.0).unwrap());
    restarted
        .register_mandate(&register_request(), at(NOW))
        .unwrap();
    let err = restarted
        .register_mandate(&mandate_for(&sub(), &other_passkey()), at(NOW))
        .unwrap_err();
    assert_eq!(err, EngineError::Auth("sub_bound".into()));
}

#[test]
fn a_tampered_record_is_rejected() {
    let dir = Dir::new("tamper");
    engine(FileRecords::open(&dir.0).unwrap())
        .register_mandate(&register_request(), at(NOW))
        .unwrap();

    let files: Vec<_> = fs::read_dir(&dir.0)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    let mut blob = fs::read(&files[0]).unwrap();
    *blob.last_mut().unwrap() ^= 1;
    fs::write(&files[0], blob).unwrap();

    let err = engine(FileRecords::open(&dir.0).unwrap())
        .register_mandate(&register_request(), at(NOW))
        .unwrap_err();
    assert_eq!(err.code(), "auth.sub_bound");
}
