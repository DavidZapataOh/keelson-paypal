//! Self-measurement of the engine process.

/// Resident set size of this process in KiB, from `VmRSS` in `/proc/self/status`.
pub fn rss_kib() -> Option<u64> {
    parse_rss_kib(&std::fs::read_to_string("/proc/self/status").ok()?)
}

fn parse_rss_kib(status: &str) -> Option<u64> {
    let line = status.lines().find_map(|l| l.strip_prefix("VmRSS:"))?;
    line.trim().strip_suffix("kB")?.trim().parse().ok()
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
    fn rss_is_readable_on_linux() {
        assert!(super::rss_kib().is_some_and(|kib| kib > 0));
    }
}
