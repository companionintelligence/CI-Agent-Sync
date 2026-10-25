# Process helpers for probes that must fail closed when a desktop approval
# dialog or a misbehaving child process does not return.
require "timeout"
require "open3"

module AgentConfigProcess
  module_function

  # `hermes --version` initialises the full application and can wait for a
  # desktop secret-store approval. Diagnostics only need the installed build
  # number, so prefer Hermes' own interpreter and package metadata when its
  # launcher exposes one. Fall back to the public command on other installs.
  def hermes_version_command(fallback = ["hermes", "--version"])
    path = ENV["AGENT_CONFIGS_HERMES_BIN"].to_s.strip
    path = `command -v hermes 2>/dev/null`.strip if path.empty?
    return fallback unless File.file?(path)

    source = File.read(path, 16_384)
    match = source.match(/exec\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+"\$@"/)
    interpreter = match && [match[1], match[2], match[3]].compact.first
    return fallback unless interpreter && File.executable?(interpreter)

    # Hermes' outer launcher delegates to a venv console script. That script
    # is itself a tiny Python launcher, so use the sibling interpreter rather
    # than passing `-c` to the Hermes entrypoint.
    if File.read(interpreter, 16_384).include?("hermes_cli")
      python = File.join(File.dirname(interpreter), "python3")
      interpreter = python if File.executable?(python)
    end

    [interpreter, "-c", "import hermes_cli; print(f'Hermes Agent v{hermes_cli.__version__}')"]
  rescue StandardError
    fallback
  end

  def onepassword_timeout(kind = :probe)
    defaults = { probe: 5, read: 12 }
    key = kind == :read ? "AGENT_CONFIGS_OP_READ_TIMEOUT_SECONDS" : "AGENT_CONFIGS_OP_PROBE_TIMEOUT_SECONDS"
    Integer(ENV.fetch(key, defaults.fetch(kind)), 10)
  rescue ArgumentError, KeyError
    defaults.fetch(kind)
  end

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
