//! Keep the shell and all inherited child processes in an owned Windows job.
use crate::{CoreError, CoreResult};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};

pub(crate) struct ProcessJob(HANDLE);

// Windows kernel handles may move between threads. Access and release are
// protected by the session resources mutex; this type has a single owner.
unsafe impl Send for ProcessJob {}

impl ProcessJob {
    pub fn new(process: HANDLE) -> CoreResult<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(CoreError::io(std::io::Error::last_os_error()));
        }
        let job = Self(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            return Err(CoreError::io(std::io::Error::last_os_error()));
        }
        if unsafe { AssignProcessToJobObject(handle, process) } == 0 {
            return Err(CoreError::new(
                "process_job_failed",
                std::io::Error::last_os_error().to_string(),
            ));
        }
        Ok(job)
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        // The non-inheritable, unnamed handle has no other owner. Closing it
        // terminates the shell plus descendants before releasing ConPTY.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
