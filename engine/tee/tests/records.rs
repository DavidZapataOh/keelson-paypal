use std::fs;
use std::path::PathBuf;

use keelson_tee::{FileRecords, UserRecords};

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
    assert!(
        FileRecords::open(&dir.0)
            .unwrap()
            .insert_new("hold\0mid", vec![4, 5])
    );

    let reopened = FileRecords::open(&dir.0).unwrap();
    assert_eq!(reopened.get("hold\0mid"), Some(vec![4, 5]));
    assert!(!reopened.insert_new("hold\0mid", vec![6]));
}
