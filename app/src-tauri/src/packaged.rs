//! "Start with Windows" for the Store (MSIX) version. Inside a package, registry Run keys are
//! private to the package and never run, so the startup task declared in Package.appxmanifest is used.

use windows::ApplicationModel::{Package, StartupTask, StartupTaskState};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use windows::core::HSTRING;

const TASK_ID: &str = "DesktopPetStartup"; // must match TaskId in Package.appxmanifest

/// The startup task when running as an installed package; None for the plain .exe.
pub fn startup_task() -> Option<StartupTask> {
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }; // fails harmlessly if already initialized
    Package::Current().ok()?;
    StartupTask::GetAsync(&HSTRING::from(TASK_ID)).ok()?.get().ok()
}

pub fn is_enabled(task: &StartupTask) -> Result<bool, String> {
    let state = task.State().map_err(|e| e.to_string())?;
    Ok(matches!(state, StartupTaskState::Enabled | StartupTaskState::EnabledByPolicy))
}

pub fn set_enabled(task: &StartupTask, enabled: bool) -> Result<bool, String> {
    if enabled {
        let state = task.RequestEnableAsync().and_then(|op| op.get()).map_err(|e| e.to_string())?;
        if state == StartupTaskState::DisabledByUser {
            return Err("Startup was turned off for Desktop Pet in Windows. Turn it back on in Settings > Apps > Startup.".into());
        }
    } else {
        task.Disable().map_err(|e| e.to_string())?;
    }
    is_enabled(task)
}
