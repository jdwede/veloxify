//! Gives lineup videos their full-size picture and stutter check, as the app does in the
//! background (prints how many, and the choppiest).
//!   cargo run --release -p cs2hl-render --example lineup_check -- <library> [seconds]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let lib = std::path::PathBuf::from(&args[0]);
    let secs: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(600);
    let t = std::time::Instant::now();
    let (n, more) = cs2hl_render::batch::check_lineup_videos(&lib, std::time::Duration::from_secs(secs));
    println!("checked {n} in {:.0}s (more left: {more})", t.elapsed().as_secs_f64());
    let clips = cs2hl_render::batch::load_lineup_clips(&lib);
    let mut choppy: Vec<(f64, &String)> = clips.iter().filter_map(|(k, c)| Some((c.stutter?, k))).collect();
    choppy.sort_by(|a, b| b.0.total_cmp(&a.0));
    let over = choppy.iter().filter(|c| c.0 > cs2hl_render::batch::STUTTER_MAX).count();
    println!("{over} of {} over the {:.0}% limit; choppiest:", choppy.len(), cs2hl_render::batch::STUTTER_MAX * 100.0);
    for (s, k) in choppy.iter().take(5) {
        println!("  {:.0}% {k}", s * 100.0);
    }
}
