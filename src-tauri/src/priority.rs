//! Pane priority: everything a pane starts may take every idle core but yields to the desktop,
//! so a fleet running its tests at once cannot freeze the machine (docs/sessions.md § Priority).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::State;

use crate::AppState;

/// What `nice` gives a command by default.
#[cfg(target_os = "macos")]
const NICE: libc::c_int = 10;

pub(crate) struct PanePriority {
    low: AtomicBool,
    /// Every pane's process joins this job, so a switch reaches the trees already running.
    #[cfg(windows)]
    job: Option<win::Job>,
}

impl PanePriority {
    pub(crate) fn new(low: bool) -> Self {
        let p = PanePriority {
            low: AtomicBool::new(low),
            #[cfg(windows)]
            job: win::Job::new(),
        };
        if let Err(e) = p.set(low) {
            log::warn!("pane priority: {e}");
        }
        p
    }

    /// Put a just-spawned pane process under the current setting. Never fails a launch.
    pub(crate) fn adopt(&self, pid: Option<u32>) {
        let Some(pid) = pid else { return };
        #[cfg(windows)]
        if let Some(job) = &self.job {
            if let Err(e) = job.assign(pid) {
                log::warn!("pane priority: pid {pid} stays outside the job: {e}");
            }
        }
        #[cfg(target_os = "macos")]
        if self.low.load(Ordering::Relaxed) {
            // SAFETY: plain syscall on a pid we just spawned; failure is reported, not fatal.
            if unsafe { libc::setpriority(libc::PRIO_PROCESS, pid, NICE) } == -1 {
                log::warn!("pane priority: pid {pid}: {}", std::io::Error::last_os_error());
            }
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = pid;
    }

    fn set(&self, low: bool) -> Result<(), String> {
        self.low.store(low, Ordering::Relaxed);
        #[cfg(windows)]
        if let Some(job) = &self.job {
            use windows_sys::Win32::System::Threading::{
                BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
            };
            if low {
                return job.limit(Some(BELOW_NORMAL_PRIORITY_CLASS));
            }
            // Lift the running trees back to normal, then let go so a program may choose again.
            job.limit(Some(NORMAL_PRIORITY_CLASS))?;
            return job.limit(None);
        }
        Ok(())
    }
}

/// Settings › Launching. On macOS only panes started afterwards follow: raising a process back
/// needs root, so lowering the running ones would be a switch that cannot be undone.
#[tauri::command(async)]
pub(crate) fn set_pane_priority(state: State<AppState>, low: bool) -> Result<(), String> {
    if state.pane_priority.low.load(Ordering::Relaxed) != low {
        log::info!("pane priority · {}", if low { "below normal" } else { "normal" });
    }
    state.pane_priority.set(low)
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_PRIORITY_CLASS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    pub(super) struct Job(HANDLE);
    // SAFETY: a job handle names a kernel object; every call made on it here is thread-safe.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    fn os_err() -> String {
        std::io::Error::last_os_error().to_string()
    }

    impl Job {
        pub(super) fn new() -> Option<Job> {
            // SAFETY: no attributes and no name: an anonymous job owned by this process.
            let h = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if h.is_null() {
                log::warn!("pane priority: no job object: {}", os_err());
                return None;
            }
            Some(Job(h))
        }

        /// `Some(class)` pins every process in the job to it, and they cannot raise themselves.
        pub(super) fn limit(&self, class: Option<u32>) -> Result<(), String> {
            // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is "no limits".
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            // Breakaway stays allowed: a program that asks to leave the job must still start.
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_BREAKAWAY_OK | class.map_or(0, |_| JOB_OBJECT_LIMIT_PRIORITY_CLASS);
            info.BasicLimitInformation.PriorityClass = class.unwrap_or(0);
            // SAFETY: `info` outlives the call and the length is its exact size.
            let ok = unsafe {
                SetInformationJobObject(
                    self.0,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 { Err(format!("set job limits: {}", os_err())) } else { Ok(()) }
        }

        /// Its children follow it into the job; only what it started before this call does not.
        pub(super) fn assign(&self, pid: u32) -> Result<(), String> {
            // SAFETY: the handle is closed below on every path.
            let p = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
            if p.is_null() {
                return Err(os_err());
            }
            let ok = unsafe { AssignProcessToJobObject(self.0, p) };
            let err = os_err();
            unsafe { CloseHandle(p) };
            if ok == 0 { Err(err) } else { Ok(()) }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // No KILL_ON_JOB_CLOSE: closing the last handle leaves every process running.
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(all(test, any(windows, target_os = "macos")))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// A child that lives long enough to be measured, killed on drop.
    struct Sleeper(std::process::Child);
    impl Drop for Sleeper {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn sleeper() -> Sleeper {
        #[cfg(windows)]
        let c = Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(Stdio::null()).spawn();
        #[cfg(not(windows))]
        let c = Command::new("sleep").arg("30").stdout(Stdio::null()).spawn();
        Sleeper(c.expect("spawn a sleeper"))
    }

    #[cfg(windows)]
    fn class_of(pid: u32) -> u32 {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetPriorityClass, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        assert!(!h.is_null(), "open pid {pid}");
        let c = unsafe { GetPriorityClass(h) };
        unsafe { CloseHandle(h) };
        c
    }

    /// Executed against real processes: the struct layout, the flags and the runtime switch are
    /// exactly what a read of the code cannot vouch for.
    #[cfg(windows)]
    #[test]
    fn job_lowers_a_pane_and_the_switch_reaches_it_while_it_runs() {
        use windows_sys::Win32::System::Threading::{BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS};
        let p = PanePriority::new(true);
        let s = sleeper();
        assert_eq!(class_of(s.0.id()), NORMAL_PRIORITY_CLASS, "a child starts at its parent's class");
        p.adopt(Some(s.0.id()));
        assert_eq!(class_of(s.0.id()), BELOW_NORMAL_PRIORITY_CLASS);
        p.set(false).unwrap();
        assert_eq!(class_of(s.0.id()), NORMAL_PRIORITY_CLASS, "switching off lifts the running pane");
        p.set(true).unwrap();
        assert_eq!(class_of(s.0.id()), BELOW_NORMAL_PRIORITY_CLASS, "and on lowers it again");
    }

    #[cfg(windows)]
    #[test]
    fn a_pane_adopted_while_off_keeps_normal() {
        use windows_sys::Win32::System::Threading::NORMAL_PRIORITY_CLASS;
        let p = PanePriority::new(false);
        let s = sleeper();
        p.adopt(Some(s.0.id()));
        assert_eq!(class_of(s.0.id()), NORMAL_PRIORITY_CLASS);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn nice_follows_the_setting_at_launch() {
        let nice = |pid: u32| unsafe { libc::getpriority(libc::PRIO_PROCESS, pid) };
        // Relative to the runner's own nice, which a child inherits and cannot go below.
        let own = nice(0);
        let low = sleeper();
        PanePriority::new(true).adopt(Some(low.0.id()));
        assert_eq!(nice(low.0.id()), NICE.max(own));
        let normal = sleeper();
        PanePriority::new(false).adopt(Some(normal.0.id()));
        assert_eq!(nice(normal.0.id()), own);
    }
}
