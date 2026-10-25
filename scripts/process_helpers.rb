# Process helpers for probes that must fail closed when a desktop approval
# dialog or a misbehaving child process does not return.
require "timeout"

module AgentConfigProcess
  module_function

  def capture_with_timeout(command, timeout_seconds)
    output_reader, output_writer = IO.pipe
    error_reader, error_writer = IO.pipe
    pid = Process.spawn(*command, in: File::NULL, out: output_writer, err: error_writer, pgroup: true)
    output_writer.close
    error_writer.close

    begin
      _pid, status = Timeout.timeout(timeout_seconds) { Process.waitpid2(pid) }
      [output_reader.read, error_reader.read, status]
    rescue Timeout::Error
      Process.kill("TERM", -pid) rescue Process.kill("TERM", pid) rescue nil
      sleep 0.05
      Process.kill("KILL", -pid) rescue Process.kill("KILL", pid) rescue nil
      Process.waitpid(pid, Process::WNOHANG) rescue nil
      ["", "", nil]
    ensure
      output_reader.close rescue nil
      error_reader.close rescue nil
      output_writer.close rescue nil
      error_writer.close rescue nil
    end
  rescue Errno::ENOENT
    ["", "command not found", nil]
  end
end
