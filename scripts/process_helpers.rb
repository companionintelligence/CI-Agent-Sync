# Process helpers for probes that must fail closed when a desktop approval
# dialog or a misbehaving child process does not return.
require "timeout"
require "open3"

module AgentConfigProcess
  module_function

  def capture_with_timeout(command, timeout_seconds)
    Open3.popen3(*command, in: File::NULL, pgroup: true) do |stdin, stdout, stderr, wait_thread|
      # Drain both pipes while the child runs. Waiting for exit before reading
      # can deadlock commands whose JSON/log output exceeds the pipe buffer.
      stdin.close rescue nil
      output_thread = Thread.new { stdout.read rescue "" }
      error_thread = Thread.new { stderr.read rescue "" }
      timed_out = false
      status = nil
      begin
        status = Timeout.timeout(timeout_seconds) { wait_thread.value }
      rescue Timeout::Error
        timed_out = true
        Process.kill("TERM", -wait_thread.pid) rescue Process.kill("TERM", wait_thread.pid) rescue nil
        sleep 0.05
        Process.kill("KILL", -wait_thread.pid) rescue Process.kill("KILL", wait_thread.pid) rescue nil
        # A desktop-auth child can survive long enough to keep the pipes open.
        # Close our read ends and stop the drainers before leaving the block so
        # a timed-out probe cannot deadlock while waiting for EOF.
        stdout.close rescue nil
        stderr.close rescue nil
        output_thread.kill
        error_thread.kill
        output_thread.join(0.2)
        error_thread.join(0.2)
        wait_thread.join(0.5)
      end
      output = timed_out ? "" : (output_thread.value rescue "")
      error = timed_out ? "" : (error_thread.value rescue "")
      stdout.close rescue nil
      stderr.close rescue nil
      timed_out ? ["", "", nil] : [output, error, status]
    end
  rescue Errno::ENOENT
    ["", "command not found", nil]
  end
end
