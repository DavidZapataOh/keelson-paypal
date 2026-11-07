//! Process-level hardening and self-measurement.

/// Resident set size of this process in KiB, from `VmRSS` in `/proc/self/status`.
pub fn rss_kib() -> Option<u64> {
    parse_rss_kib(&std::fs::read_to_string("/proc/self/status").ok()?)
}

fn parse_rss_kib(status: &str) -> Option<u64> {
    let line = status.lines().find_map(|l| l.strip_prefix("VmRSS:"))?;
    line.trim().strip_suffix("kB")?.trim().parse().ok()
}

/// Marks the process non-dumpable (`PR_SET_DUMPABLE` 0), so a crash writes no core file and no
/// other process of the same user can attach to read its memory.
#[cfg(target_os = "linux")]
pub fn forbid_dumps() -> std::io::Result<()> {
    rustix::process::set_dumpable_behavior(rustix::process::DumpableBehavior::NotDumpable)
        .map_err(Into::into)
}

/// Marks the process non-dumpable on Linux; other platforms have nothing to set.
#[cfg(not(target_os = "linux"))]
pub fn forbid_dumps() -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_rss_kib;

    #[test]
    fn reads_vmrss() {
        let status =
            "Name:\tkeelson-engine\nVmPeak:\t  90000 kB\nVmRSS:\t   12345 kB\nThreads:\t4\n";
        assert_eq!(parse_rss_kib(status), Some(12_345));
    }

    #[test]
    fn missing_or_malformed_vmrss_is_none() {
        assert_eq!(parse_rss_kib("Name:\tx\n"), None);
        assert_eq!(parse_rss_kib("VmRSS:\tlots kB\n"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_hardened_process_is_not_dumpable() {
        super::forbid_dumps().unwrap();
        assert_eq!(
            rustix::process::dumpable_behavior().unwrap(),
            rustix::process::DumpableBehavior::NotDumpable
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rss_is_readable_on_linux() {
        assert!(super::rss_kib().is_some_and(|kib| kib > 0));
    }
}
