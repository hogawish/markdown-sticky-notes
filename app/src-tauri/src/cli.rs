//! 外から、動いているアプリの付箋を操作するコマンドライン(引数の解析と、位置の計算)。
//!
//! ```text
//! app.exe open <path> [--monitor primary|N] [--anchor top-left|top-right|bottom-left|bottom-right|center]
//!                     [--margin PX] [--x X --y Y] [--width W] [--height H]
//!                     [--pin | --no-pin] [--create] [--focus] [--result FILE.json]
//! app.exe close <path> [--result FILE.json]
//! ```
//!
//! 2つ目の起動は、動いているアプリへ引数を渡して終わる(単一起動の仕組み)。
//! ここは、アプリの状態に依存しない部分だけを持つ(試験しやすくするため)。

/// 付箋の窓の隅。モニターの作業領域(タスクバーを除いた範囲)を基準にする。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Anchor {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Center,
}

/// 置くモニター。番号は、左から順に1、2、…(同じ左端なら上から)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MonitorSel {
    Primary,
    Index(usize),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    /// 位置は変えない(開いていなければ、保存した位置か、既定の位置)
    Keep,
    /// モニターの隅に置く。margin は論理px(DPIに依らない余白)
    Monitor { sel: MonitorSel, anchor: Anchor, margin: f64 },
    /// 見えている窓の左上を、画面全体の座標(物理px)で指定する
    Absolute { x: i32, y: i32 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Placement {
    pub target: Target,
    /// 見えている窓の大きさ(論理px)。指定がなければ、いまの大きさを保つ
    pub width: Option<f64>,
    pub height: Option<f64>,
}

impl Placement {
    pub fn is_keep(&self) -> bool {
        self.target == Target::Keep && self.width.is_none() && self.height.is_none()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Open {
        path: String,
        placement: Placement,
        /// None: 変えない
        pin: Option<bool>,
        /// 付箋のファイルが無ければ、空で作る(登録フォルダの中だけ)
        create: bool,
        /// true なら、窓にフォーカスを渡す。既定は、作業中の窓からフォーカスを奪わない
        focus: bool,
        result: Option<String>,
    },
    Close {
        path: String,
        result: Option<String>,
    },
}

impl Command {
    pub fn result(&self) -> Option<&str> {
        match self {
            Command::Open { result, .. } | Command::Close { result, .. } => result.as_deref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CliError {
    pub message: String,
    /// 解析の途中で分かった、結果ファイルの場所(エラーも、そこへ書くため)
    pub result: Option<String>,
}

pub const DEFAULT_MARGIN: f64 = 16.0;
pub const MIN_WIDTH: f64 = 160.0;
pub const MIN_HEIGHT: f64 = 100.0;

fn split_opt(arg: &str) -> (&str, Option<&str>) {
    match arg.split_once('=') {
        Some((k, v)) if k.starts_with("--") => (k, Some(v)),
        _ => (arg, None),
    }
}

/// 結果ファイルの指定だけを、先に拾う(他の引数が壊れていても、エラーを書き出せるように)
fn scan_result(args: &[String]) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let (k, v) = split_opt(a);
        if k == "--result" {
            return v.map(str::to_owned).or_else(|| it.next().cloned());
        }
    }
    None
}

fn parse_anchor(s: &str) -> Option<Anchor> {
    Some(match s {
        "top-left" => Anchor::TopLeft,
        "top-right" => Anchor::TopRight,
        "bottom-left" => Anchor::BottomLeft,
        "bottom-right" => Anchor::BottomRight,
        "center" => Anchor::Center,
        _ => return None,
    })
}

/// 引数(プログラム名は含まない)を解析する。
/// - `Ok(None)`: このコマンドラインの対象ではない(普通の起動)
/// - `Err(..)`: `open` / `close` だが、引数が正しくない
pub fn parse(args: &[String]) -> Result<Option<Command>, CliError> {
    let Some(name) = args.first().map(String::as_str) else { return Ok(None) };
    if name != "open" && name != "close" {
        return Ok(None);
    }
    let result = scan_result(args);
    let fail = |m: String| CliError { message: m, result: result.clone() };

    let mut path: Option<String> = None;
    let mut monitor: Option<MonitorSel> = None;
    let mut anchor: Option<Anchor> = None;
    let mut margin: Option<f64> = None;
    let (mut x, mut y): (Option<i32>, Option<i32>) = (None, None);
    let (mut width, mut height): (Option<f64>, Option<f64>) = (None, None);
    let (mut pin, mut no_pin, mut create, mut focus) = (false, false, false, false);
    let mut used: Vec<String> = Vec::new();

    let mut it = args[1..].iter();
    while let Some(arg) = it.next() {
        if !arg.starts_with("--") {
            if path.replace(arg.clone()).is_some() {
                return Err(fail(format!("付箋のパスは1つだけ指定してください: {arg}")));
            }
            continue;
        }
        let (key, inline) = split_opt(arg);
        used.push(key.to_owned());
        let needs_value = matches!(
            key,
            "--monitor" | "--anchor" | "--margin" | "--x" | "--y" | "--width" | "--height" | "--result"
        );
        let value: Option<String> = if needs_value {
            match inline {
                Some(v) => Some(v.to_owned()),
                None => Some(it.next().cloned().ok_or_else(|| fail(format!("{key} には値が必要です")))?),
            }
        } else if inline.is_some() {
            return Err(fail(format!("{key} には値を付けられません")));
        } else {
            None
        };
        let v = value.as_deref().unwrap_or("");
        let num = |what: &str| v.parse::<f64>().ok().filter(|n| n.is_finite()).ok_or_else(|| fail(format!("{what} は数値で指定してください: {v}")));
        let int = |what: &str| v.parse::<i32>().map_err(|_| fail(format!("{what} は整数で指定してください: {v}")));
        match key {
            "--monitor" => {
                monitor = Some(if v == "primary" {
                    MonitorSel::Primary
                } else {
                    match v.parse::<usize>() {
                        Ok(n) if n >= 1 => MonitorSel::Index(n),
                        _ => return Err(fail(format!("--monitor は primary か、1以上の番号で指定してください: {v}"))),
                    }
                })
            }
            "--anchor" => anchor = Some(parse_anchor(v).ok_or_else(|| fail(format!("--anchor は top-left / top-right / bottom-left / bottom-right / center のどれかです: {v}")))?),
            "--margin" => {
                let n = num("--margin")?;
                if n < 0.0 {
                    return Err(fail("--margin は0以上にしてください".into()));
                }
                margin = Some(n)
            }
            "--x" => x = Some(int("--x")?),
            "--y" => y = Some(int("--y")?),
            "--width" => width = Some(num("--width")?),
            "--height" => height = Some(num("--height")?),
            "--pin" => pin = true,
            "--no-pin" => no_pin = true,
            "--create" => create = true,
            "--focus" => focus = true,
            "--result" => {
                let p = v.to_owned();
                if !p.to_lowercase().ends_with(".json") {
                    return Err(fail("--result は .json のファイルを指定してください".into()));
                }
            }
            other => return Err(fail(format!("知らない引数です: {other}"))),
        }
    }

    let path = path.ok_or_else(|| fail("付箋のパスを指定してください".into()))?;

    if name == "close" {
        if let Some(bad) = used.iter().find(|k| k.as_str() != "--result") {
            return Err(fail(format!("close では使えない引数です: {bad}")));
        }
        return Ok(Some(Command::Close { path, result }));
    }

    if pin && no_pin {
        return Err(fail("--pin と --no-pin は、同時に指定できません".into()));
    }
    if x.is_some() != y.is_some() {
        return Err(fail("--x と --y は、両方を指定してください".into()));
    }
    let by_monitor = monitor.is_some() || anchor.is_some() || margin.is_some();
    if x.is_some() && by_monitor {
        return Err(fail("--x/--y と、--monitor/--anchor/--margin は、同時に指定できません".into()));
    }
    if let Some(w) = width {
        if w < MIN_WIDTH {
            return Err(fail(format!("--width は{MIN_WIDTH}以上にしてください")));
        }
    }
    if let Some(h) = height {
        if h < MIN_HEIGHT {
            return Err(fail(format!("--height は{MIN_HEIGHT}以上にしてください")));
        }
    }
    let target = if let (Some(x), Some(y)) = (x, y) {
        Target::Absolute { x, y }
    } else if by_monitor {
        Target::Monitor {
            sel: monitor.unwrap_or(MonitorSel::Primary),
            anchor: anchor.unwrap_or(Anchor::TopLeft),
            margin: margin.unwrap_or(DEFAULT_MARGIN),
        }
    } else {
        Target::Keep
    };
    Ok(Some(Command::Open {
        path,
        placement: Placement { target, width, height },
        pin: if pin { Some(true) } else if no_pin { Some(false) } else { None },
        create,
        focus,
        result,
    }))
}

/// 物理pxの長方形。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 作業領域 `area` の中で、大きさ `(w, h)` の窓を、隅 `anchor` に置いたときの左上(物理px)。
/// 窓が領域に収まるなら、はみ出さないように寄せる。
pub fn place(area: Rect, w: i32, h: i32, anchor: Anchor, margin: i32) -> (i32, i32) {
    let (left, right) = (area.x + margin, area.x + area.w - w - margin);
    let (top, bottom) = (area.y + margin, area.y + area.h - h - margin);
    let (mut x, mut y) = match anchor {
        Anchor::TopLeft => (left, top),
        Anchor::TopRight => (right, top),
        Anchor::BottomLeft => (left, bottom),
        Anchor::BottomRight => (right, bottom),
        Anchor::Center => (area.x + (area.w - w) / 2, area.y + (area.h - h) / 2),
    };
    if w <= area.w {
        x = x.clamp(area.x, area.x + area.w - w);
    } else {
        x = area.x;
    }
    if h <= area.h {
        y = y.clamp(area.y, area.y + area.h - h);
    } else {
        y = area.y;
    }
    (x, y)
}

/// モニターの左上の座標の一覧から、「左から順(同じなら上から)」の並びを返す。
/// 返すのは、元の一覧の添字。先頭がモニター1。
pub fn monitor_order(positions: &[(i32, i32)]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..positions.len()).collect();
    idx.sort_by_key(|&i| (positions[i].0, positions[i].1, i));
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn open(v: &[&str]) -> Command {
        parse(&a(v)).unwrap().unwrap()
    }

    fn err(v: &[&str]) -> String {
        parse(&a(v)).unwrap_err().message
    }

    #[test]
    fn ordinary_start_is_not_a_command() {
        assert_eq!(parse(&a(&[])), Ok(None));
        assert_eq!(parse(&a(&["--tab-host", "chrome"])), Ok(None));
        assert_eq!(parse(&a(&["chrome-extension://x/"])), Ok(None));
    }

    #[test]
    fn open_with_monitor_anchor_and_pin() {
        let c = open(&["open", r"C:\n\today.md", "--monitor", "2", "--anchor", "top-left", "--pin"]);
        assert_eq!(
            c,
            Command::Open {
                path: r"C:\n\today.md".into(),
                placement: Placement {
                    target: Target::Monitor { sel: MonitorSel::Index(2), anchor: Anchor::TopLeft, margin: DEFAULT_MARGIN },
                    width: None,
                    height: None
                },
                pin: Some(true),
                create: false,
                focus: false,
                result: None,
            }
        );
    }

    #[test]
    fn open_without_options_keeps_everything() {
        match open(&["open", "a.md"]) {
            Command::Open { placement, pin, focus, create, .. } => {
                assert!(placement.is_keep());
                assert_eq!((pin, focus, create), (None, false, false));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn equals_form_and_option_order() {
        match open(&["open", "--monitor=primary", "--anchor=bottom-right", "--margin=0", "a.md", "--no-pin", "--result=r.json", "--focus", "--create"]) {
            Command::Open { path, placement, pin, focus, create, result } => {
                assert_eq!(path, "a.md");
                assert_eq!(placement.target, Target::Monitor { sel: MonitorSel::Primary, anchor: Anchor::BottomRight, margin: 0.0 });
                assert_eq!((pin, focus, create), (Some(false), true, true));
                assert_eq!(result.as_deref(), Some("r.json"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn monitor_alone_defaults_to_top_left_and_anchor_alone_to_primary() {
        match open(&["open", "a.md", "--monitor", "3"]) {
            Command::Open { placement, .. } => assert_eq!(
                placement.target,
                Target::Monitor { sel: MonitorSel::Index(3), anchor: Anchor::TopLeft, margin: DEFAULT_MARGIN }
            ),
            _ => panic!(),
        }
        match open(&["open", "a.md", "--anchor", "center"]) {
            Command::Open { placement, .. } => assert_eq!(
                placement.target,
                Target::Monitor { sel: MonitorSel::Primary, anchor: Anchor::Center, margin: DEFAULT_MARGIN }
            ),
            _ => panic!(),
        }
    }

    #[test]
    fn absolute_position_and_size() {
        match open(&["open", "a.md", "--x", "-1920", "--y", "40", "--width", "300", "--height", "200.5"]) {
            Command::Open { placement, .. } => {
                assert_eq!(placement.target, Target::Absolute { x: -1920, y: 40 });
                assert_eq!((placement.width, placement.height), (Some(300.0), Some(200.5)));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn close_takes_a_path_and_result_only() {
        assert_eq!(open(&["close", "a.md"]), Command::Close { path: "a.md".into(), result: None });
        assert_eq!(
            open(&["close", "a.md", "--result", "r.json"]),
            Command::Close { path: "a.md".into(), result: Some("r.json".into()) }
        );
        assert!(err(&["close", "a.md", "--pin"]).contains("--pin"));
    }

    #[test]
    fn bad_arguments_are_rejected_with_a_reason() {
        assert!(err(&["open"]).contains("パス"));
        assert!(err(&["open", "a.md", "b.md"]).contains("1つだけ"));
        assert!(err(&["open", "a.md", "--monitor", "0"]).contains("--monitor"));
        assert!(err(&["open", "a.md", "--monitor", "left"]).contains("--monitor"));
        assert!(err(&["open", "a.md", "--anchor", "middle"]).contains("--anchor"));
        assert!(err(&["open", "a.md", "--margin", "-1"]).contains("--margin"));
        assert!(err(&["open", "a.md", "--margin", "abc"]).contains("数値"));
        assert!(err(&["open", "a.md", "--x", "1"]).contains("両方"));
        assert!(err(&["open", "a.md", "--x", "1", "--y", "2", "--monitor", "2"]).contains("同時"));
        assert!(err(&["open", "a.md", "--pin", "--no-pin"]).contains("同時"));
        assert!(err(&["open", "a.md", "--width", "50"]).contains("--width"));
        assert!(err(&["open", "a.md", "--height", "10"]).contains("--height"));
        assert!(err(&["open", "a.md", "--bogus"]).contains("--bogus"));
        assert!(err(&["open", "a.md", "--pin=1"]).contains("--pin"));
        assert!(err(&["open", "a.md", "--monitor"]).contains("値"));
        assert!(err(&["open", "a.md", "--result", "r.txt"]).contains(".json"));
    }

    #[test]
    fn a_result_file_is_reported_even_when_the_rest_is_wrong() {
        let e = parse(&a(&["open", "a.md", "--anchor", "nowhere", "--result", "out.json"])).unwrap_err();
        assert_eq!(e.result.as_deref(), Some("out.json"));
        let e = parse(&a(&["open", "--result=out.json"])).unwrap_err();
        assert_eq!(e.result.as_deref(), Some("out.json"));
    }

    #[test]
    fn place_puts_the_window_in_each_corner() {
        let area = Rect { x: -1920, y: 0, w: 1920, h: 1040 };
        assert_eq!(place(area, 280, 240, Anchor::TopLeft, 16), (-1904, 16));
        assert_eq!(place(area, 280, 240, Anchor::TopRight, 16), (-296, 16));
        assert_eq!(place(area, 280, 240, Anchor::BottomLeft, 16), (-1904, 784));
        assert_eq!(place(area, 280, 240, Anchor::BottomRight, 16), (-296, 784));
        assert_eq!(place(area, 280, 240, Anchor::Center, 16), (-1100, 400));
    }

    #[test]
    fn place_keeps_a_big_window_inside_or_flush_to_the_corner() {
        let area = Rect { x: 0, y: 0, w: 300, h: 200 };
        assert_eq!(place(area, 280, 180, Anchor::TopLeft, 50), (20, 20)); // 余白を詰めて、はみ出さない
        assert_eq!(place(area, 400, 300, Anchor::BottomRight, 16), (0, 0)); // 領域より大きいときは、左上に合わせる
    }

    #[test]
    fn monitors_are_numbered_left_to_right() {
        // OSの並び: [主(0,0), 左(-1920,0), 右(1920,-200), 右の上(1920,-1280)]
        let order = monitor_order(&[(0, 0), (-1920, 0), (1920, -200), (1920, -1280)]);
        assert_eq!(order, vec![1, 0, 3, 2]);
        assert_eq!(monitor_order(&[]), Vec::<usize>::new());
    }
}
