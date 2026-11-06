//! The local socket a running E8 listens on, so `e8-mcp` can let an
//! agent use the editor the user sees. It is a Unix domain socket in a
//! directory only the user can open, since whoever connects can run any
//! command: nothing goes over a network.
//!
//! The editor is not shared between threads, so connections hand each
//! message to the editor's own thread as a [`Request`] and wait for the reply.

use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

/// One message from a connection, for the editor's thread to answer with
/// [`crate::handle_message`] and send back on `reply`.
pub struct Request {
    pub line: String,
    pub reply: Sender<Option<String>>,
}

/// Where the socket goes: `$E8_SOCKET`, or `gui.sock` in a directory of
/// the user's own under the temporary directory, named by uid.
pub fn default_path() -> PathBuf {
    if let Some(path) = std::env::var_os("E8_SOCKET") {
        return PathBuf::from(path);
    }
    default_dir().join("gui.sock")
}

/// The directory of the user's own the socket goes in by default, named by
/// uid, as `$USER` can be anything.
fn default_dir() -> PathBuf {
    std::env::temp_dir().join(format!("e8-{}", uid()))
}

fn uid() -> u32 {
    // SAFETY: getuid cannot fail and touches no memory of ours.
    unsafe { libc::getuid() }
}

/// Fails unless `dir` is a directory, not a link, that this user owns and
/// no one else can open, as one in a shared `/tmp` may have been made by
/// someone else first.
fn check_private(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.is_dir() || meta.uid() != uid() || meta.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is not a directory of your own that only you can open", dir.display()),
        ));
    }
    Ok(())
}

/// Listens on `path`, calling `wake` whenever a request waits so the
/// editor's thread can take it from the receiver. Fails if another E8 is
/// listening there already; a socket left by one that has gone is replaced.
pub fn listen(path: &Path, wake: impl Fn() + Send + Sync + 'static) -> io::Result<Receiver<Request>> {
    // A directory made here is the user's alone; one that was there, as
    // the home directory `E8_SOCKET=~/x.sock` names, is left as it is,
    // except the default one, which must already be the user's alone.
    if let Some(dir) = path.parent() {
        if !dir.exists() {
            std::fs::create_dir_all(dir)?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        if dir == default_dir() {
            check_private(dir)?;
        }
    }
    if path.exists() {
        if UnixStream::connect(path).is_ok() {
            return Err(io::Error::new(io::ErrorKind::AddrInUse, format!("Another E8 listens on {}", path.display())));
        }
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    let (tx, rx) = mpsc::channel();
    let wake = std::sync::Arc::new(wake);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (tx, wake) = (tx.clone(), wake.clone());
            thread::spawn(move || serve(stream, &tx, &*wake));
        }
    });
    Ok(rx)
}

/// Answers a connection's messages, a line each, until it closes.
fn serve(stream: UnixStream, requests: &Sender<Request>, wake: &(dyn Fn() + Send + Sync)) {
    let Ok(mut out) = stream.try_clone() else { return };
    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { return };
        if line.trim().is_empty() {
            continue;
        }
        let (reply, answer) = mpsc::channel();
        if requests.send(Request { line, reply }).is_err() {
            return;
        }
        wake();
        match answer.recv() {
            Ok(Some(text)) => {
                if writeln!(out, "{text}").and_then(|()| out.flush()).is_err() {
                    return;
                }
            }
            Ok(None) => {}
            Err(_) => return,
        }
    }
}

/// Passes messages between standard input and output and a running E8's
/// socket, until either side closes.
pub fn proxy(stream: UnixStream) -> io::Result<()> {
    let mut to_editor = stream.try_clone()?;
    let from_editor = BufReader::new(stream);
    let replies = thread::spawn(move || -> io::Result<()> {
        let mut stdout = io::stdout();
        for line in from_editor.lines() {
            writeln!(stdout, "{}", line?)?;
            stdout.flush()?;
        }
        Ok(())
    });
    for line in io::stdin().lock().lines() {
        writeln!(to_editor, "{}", line?)?;
        to_editor.flush()?;
    }
    to_editor.shutdown(std::net::Shutdown::Write)?;
    replies.join().unwrap_or(Ok(()))
}
