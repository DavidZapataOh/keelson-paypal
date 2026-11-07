use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::UserRecords;

/// Sealed records kept one per file in a directory.
///
/// A key is stored under the hex SHA-256 of its text. A record appears whole or not at all: it is
/// written to a temporary file, synced, and linked into place, which fails when the key is taken.
pub struct FileRecords {
    dir: PathBuf,
}

impl FileRecords {
    /// Opens the store at `dir`, creating it when it does not exist.
    pub fn open(dir: impl AsRef<Path>) -> std::io::Result<Self> {
        fs::create_dir_all(dir.as_ref())?;
        Ok(Self {
            dir: dir.as_ref().to_owned(),
        })
    }

    fn path(&self, key: &str) -> PathBuf {
        let name: String = Sha256::digest(key.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        self.dir.join(name)
    }
}

impl UserRecords for FileRecords {
    fn get(&self, key: &str) -> Option<Vec<u8>> {
        fs::read(self.path(key)).ok()
    }

    fn insert_new(&self, key: &str, record: Vec<u8>) -> bool {
        let path = self.path(key);
        let staged = path.with_extension(format!("{}.tmp", ulid::Ulid::generate()));
        let written = fs::File::create(&staged)
            .and_then(|mut file| file.write_all(&record).and_then(|()| file.sync_all()))
            .and_then(|()| fs::hard_link(&staged, &path));
        let _ = fs::remove_file(&staged);
        written.is_ok()
    }
}
