//! Main-window sizing helpers.

/// First-run window size: ~85% of the monitor's logical area, clamped so it
/// never drops below the minimum window size or exceeds the monitor itself.
pub fn target_window_size(monitor_w_px: u32, monitor_h_px: u32, scale: f64) -> (f64, f64) {
    let scale = if scale <= 0.0 { 1.0 } else { scale };
    let max_w = monitor_w_px as f64 / scale;
    let max_h = monitor_h_px as f64 / scale;
    let w = (max_w * 0.85).clamp(800.0_f64.min(max_w), max_w);
    let h = (max_h * 0.85).clamp(600.0_f64.min(max_h), max_h);
    (w, h)
}

#[cfg(test)]
mod tests {
    use super::target_window_size;

    #[test]
    fn fits_monitor_and_respects_bounds() {
        // 4K @ 2x scale -> 85% of logical 1920x1080 = 1632x918.
        let (w, h) = target_window_size(3840, 2160, 2.0);
        assert!((w - 1632.0).abs() < 1.0, "w={}", w);
        assert!((h - 918.0).abs() < 1.0, "h={}", h);
        // 1280x800 @1x -> 85% = 1088x680 (above the 800x600 floor).
        let (w2, h2) = target_window_size(1280, 800, 1.0);
        assert!((w2 - 1088.0).abs() < 1.0 && (h2 - 680.0).abs() < 1.0);
        // A small monitor never yields a window larger than the monitor.
        let (w3, h3) = target_window_size(1024, 640, 1.0);
        assert!(w3 <= 1024.0 && h3 <= 640.0);
    }
}
