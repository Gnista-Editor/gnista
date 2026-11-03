//! Windows and frames.

use crate::natives::{natives, Record};

natives! {
    fn splitWindow(ed, window: Option<u64>, side_by_side: bool, size: Option<i64>) -> u64 {
        ed.split_window_sized(window, side_by_side, size)
    }

    /// Delete a window, the selected one by default, giving its space to its neighbour.
    #[ts = "(window?: number): void"]
    pub fn deleteWindow(ed, window: Option<u64>) {
        ed.delete_window(window)
    }

    /// Make a window the selected one, whose buffer commands act on.
    pub fn selectWindow(ed, window: u64) {
        ed.select_window(window)
    }

    pub fn selectedWindow(ed) -> u64 {
        Ok(if ed.minibuffer_window_selected() { ember_core::MINIBUFFER_WINDOW } else { ed.selected_window() })
    }

    /// How many minibuffers are open, one inside another, as minibuffer-depth.
    pub fn minibufferDepth(ed) -> usize {
        Ok(ed.minibuffer_depth())
    }

    fn windowBuffer(ed, window: u64) -> Option<String> {
        if window == ember_core::MINIBUFFER_WINDOW {
            return Ok(Some(ed.minibuffer().name.clone()));
        }
        Ok(ed.window_buffer_name(window).map(str::to_string))
    }

    /// Make the current buffer read-only, or writable again, as setting buffer-read-only does.
    pub fn setReadOnly(ed, on: bool) {
        ed.buffer_mut().read_only = on;
        Ok(())
    }

    /// Whether the current buffer is read-only, as Emacs's buffer-read-only.
    pub fn bufferReadOnly(ed) -> bool {
        Ok(ed.buffer().read_only)
    }

    fn setCurrentBuffer(ed, name: String) -> String {
        ed.set_current_buffer(&name)
    }

    fn getBufferCreate(ed, name: String) {
        ed.get_buffer_create(&name);
        Ok(())
    }

    /// Visit a file without showing it, as find-file-noselect, and return its buffer's name.
    pub fn findFileNoselect(ed, file: String) -> String {
        ed.find_file_noselect(&ed.expand_file_name(&file))
    }

    fn makeFrame(ed, buffer: Option<String>) -> u64 {
        ed.make_frame(buffer.as_deref())
    }

    /// Delete a frame, the selected one by default, and its windows, as delete-frame does.
    #[ts = "(frame?: number): void"]
    pub fn deleteFrame(ed, frame: Option<u64>) {
        ed.delete_frame(frame)
    }

    /// Make a frame the selected one, as select-frame does.
    pub fn selectFrame(ed, frame: u64) {
        ed.select_frame(frame)
    }

    pub fn selectedFrame(ed) -> u64 {
        Ok(ed.selected_frame())
    }

    /// The frames, newest first, as frame-list orders them.
    pub fn frameList(ed) -> Vec<u64> {
        Ok(ed.frame_list())
    }

    fn setWindowBuffer(ed, window: u64, buffer: String) {
        ed.set_window_buffer(window, &buffer)
    }

    fn windowSize(ed, window: u64) -> Option<Vec<usize>> {
        let total = ed.window_total_sizes().into_iter().find(|s| s.0 == window);
        let full = usize::from(ed.window_full_width(window));
        Ok(ed.window_size(window).zip(total).map(|((w, h), (_, tw, th))| vec![w, h, tw, th, full]))
    }

    fn windowUseTime(ed, window: u64) -> Option<u64> {
        Ok(ed.window_use_time(window))
    }

    fn resizeWindow(ed, window: Option<u64>, delta: i64, horizontal: bool, apply: bool) -> i64 {
        ed.resize_window(window, delta, horizontal, apply)
    }

    /// Make windows the same size as their neighbours, as balance-windows does.
    pub fn balanceWindows(ed) {
        ed.balance_windows();
        Ok(())
    }

    /// The windows in cyclic order, left to right and top to bottom, as other-window visits them.
    pub fn windowList(ed) -> Vec<u64> {
        // The minibuffer's window comes last while a prompt is open, as in Emacs's window-list.
        let mut windows = ed.window_list();
        if ed.prompt().is_some() {
            windows.push(ember_core::MINIBUFFER_WINDOW);
        }
        Ok(windows)
    }

    /// `{ window, position }`, with `start` for a drag's start.
    fn lastMouseEvent(ed) -> Option<Record> {
        Ok(ed.last_mouse_event().map(|event| {
            let record = Record::new().with("window", event.window).with("position", event.position);
            match event.start {
                Some((window, position)) => record.with("start", Record::new().with("window", window).with("position", position)),
                None => record,
            }
        }))
    }

    /// The screen line a position shows on in the selected window, where long
    /// lines are continued: where it starts and ends, and whether its line of
    /// text goes on in the next screen line. Where lines are not continued,
    /// the line of text itself.
    #[ts = "(position: number): { start: number; end: number; continued: boolean }"]
    pub fn screenLine(ed, pos: usize) -> Record {
        let (start, end, continued) = ed.screen_line(pos);
        Ok(Record::new().with("start", start).with("end", end).with("continued", continued))
    }
}
