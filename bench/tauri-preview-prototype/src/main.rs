use serde::Serialize;
use std::env;
use std::io::{self, Read};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const WIDTH: usize = 640;
const HEIGHT: usize = 360;
const FRAME_BYTES: usize = WIDTH * HEIGHT * 3;

#[derive(Serialize)]
struct ResultRow {
    config: String,
    frames: usize,
    seconds: f64,
    fps: f64,
    average_frame_ms: f64,
    p95_frame_ms: f64,
    p99_frame_ms: f64,
    dropped_vs_29_97: f64,
    bytes_per_frame: usize,
    transport_bytes_per_second: f64,
    exit_code: Option<i32>,
}

fn percentile(samples: &mut [f64], quantile: f64) -> f64 {
    if samples.is_empty() { return 0.0; }
    samples.sort_by(f64::total_cmp);
    samples[((samples.len() - 1) as f64 * quantile).round() as usize]
}

fn escaped(path: &str) -> String {
    path.replace('\\', "/").replace(':', "\\:").replace('\'', "\\'")
}

fn graph(config: &str, technical: &str, creative: &str, _watermark: &str) -> String {
    let base = match config {
        "A" => "[0:v]format=rgb24[v]".to_string(),
        "B" => format!("[0:v]lut3d=file='{}',format=rgb24[v]", escaped(technical)),
        "C" => format!("[0:v]lut3d=file='{}',format=rgb24[v]", escaped(creative)),
        "D" => format!("[1:v]format=rgba,scale=iw*0.5:-1[wm];[0:v][wm]overlay=W-w-24:H-h-24,format=rgb24[v]"),
        "E" => format!("[0:v]lut3d=file='{}',lut3d=file='{}'[graded];[1:v]format=rgba,scale=iw*0.5:-1[wm];[graded][wm]overlay=W-w-24:H-h-24,format=rgb24[v]", escaped(technical), escaped(creative)),
        _ => panic!("config must be A, B, C, D, or E"),
    };
    format!("{};[v]scale={}:{}[outv]", base, WIDTH, HEIGHT)
}

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 7 {
        eprintln!("usage: tauri-preview-prototype <A-E> <seconds> <source> <technical.cube> <creative.cube> <watermark.png>");
        std::process::exit(2);
    }
    let config = &args[1];
    let duration: f64 = args[2].parse().expect("invalid seconds");
    let mut command = Command::new(env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into()));
    command.args(["-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-hwaccel", "auto", "-i", &args[3]]);
    if config == "D" || config == "E" {
        command.args(["-loop", "1", "-i", &args[6]]);
    }
    command.args(["-filter_complex", &graph(config, &args[4], &args[5], &args[6]), "-map", "[outv]", "-t", &duration.to_string(), "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    command.stdout(Stdio::piped()).stderr(Stdio::inherit());
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().expect("ffmpeg stdout");
    let mut frame = vec![0_u8; FRAME_BYTES];
    let start = Instant::now();
    let mut previous = start;
    let mut intervals = Vec::new();
    let mut frames = 0usize;
    loop {
        match stdout.read_exact(&mut frame) {
            Ok(()) => {
                let now = Instant::now();
                if frames > 0 { intervals.push((now - previous).as_secs_f64() * 1000.0); }
                previous = now;
                frames += 1;
                std::hint::black_box(frame[frames % FRAME_BYTES]);
                let presentation_deadline = start + Duration::from_secs_f64(frames as f64 / 29.97);
                if let Some(remaining) = presentation_deadline.checked_duration_since(Instant::now()) {
                    sleep(remaining);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error),
        }
    }
    let status = child.wait()?;
    let elapsed = start.elapsed().as_secs_f64();
    let average = if intervals.is_empty() { 0.0 } else { intervals.iter().sum::<f64>() / intervals.len() as f64 };
    let mut p95_values = intervals.clone();
    let mut p99_values = intervals;
    let result = ResultRow {
        config: config.clone(), frames, seconds: elapsed, fps: frames as f64 / elapsed,
        average_frame_ms: average,
        p95_frame_ms: percentile(&mut p95_values, 0.95),
        p99_frame_ms: percentile(&mut p99_values, 0.99),
        dropped_vs_29_97: (29.97 * duration - frames as f64).max(0.0),
        bytes_per_frame: FRAME_BYTES,
        transport_bytes_per_second: FRAME_BYTES as f64 * frames as f64 / elapsed,
        exit_code: status.code(),
    };
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
    Ok(())
}
