//! Loads a map's collision geometry from CS2's files and reports what's in it, then times a batch
//! of line-of-sight checks.
//!   cargo run --release -p cs2hl-core --example mapgeo_probe -- <path to game/csgo> <map> [x y z x y z]
use cs2hl_core::mapgeo;
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let csgo = PathBuf::from(&args[0]);
    let map = &args[1];
    let t = std::time::Instant::now();
    let phys = mapgeo::load_physics(&csgo, map)?;
    println!("parsed PHYS in {:.2}s", t.elapsed().as_secs_f64());
    if let mapgeo::Kv::Object(top) = &phys {
        println!("top-level keys: {:?}", top.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>());
    }
    let (attrs, tris) = mapgeo::physics_triangles(&phys);
    for (i, a) in attrs.iter().enumerate() {
        let n = tris.iter().filter(|(k, _)| *k == i).count();
        println!("attribute {i}: {a:?} -> {n} triangles, blocks sight: {}", mapgeo::blocks_sight(a));
    }
    let t = std::time::Instant::now();
    let g = mapgeo::load(&csgo, map)?;
    println!("geometry: {} solid triangles, built in {:.2}s", g.tris.len(), t.elapsed().as_secs_f64());
    let (mut min, mut max) = ([f32::MAX; 3], [f32::MIN; 3]);
    for t in &g.tris {
        for v in t {
            for k in 0..3 {
                min[k] = min[k].min(v[k]);
                max[k] = max[k].max(v[k]);
            }
        }
    }
    println!("bounds {min:?} .. {max:?}");
    if args.len() >= 8 {
        let p: Vec<f32> = args[2..8].iter().map(|s| s.parse().unwrap()).collect();
        println!("clear: {}", g.clear([p[0], p[1], p[2]], [p[3], p[4], p[5]]));
    }
    // Random segments inside the map, to time the ray casts.
    let mut seed = 12345u64;
    let mut rnd = |lo: f32, hi: f32| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        lo + (hi - lo) * ((seed >> 33) as f32 / (1u64 << 31) as f32)
    };
    let t = std::time::Instant::now();
    let mut clear = 0;
    let n = 200_000;
    for _ in 0..n {
        let a = [rnd(min[0], max[0]), rnd(min[1], max[1]), rnd(min[2], max[2])];
        let b = [a[0] + rnd(-1500.0, 1500.0), a[1] + rnd(-1500.0, 1500.0), a[2] + rnd(-100.0, 100.0)];
        clear += g.clear(a, b) as u32;
    }
    println!("{n} rays in {:.2}s ({clear} clear)", t.elapsed().as_secs_f64());
    Ok(())
}
