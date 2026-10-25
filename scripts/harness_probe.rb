# Resolve a safe version probe for a harness without invoking an interactive
# startup path. Some clients load external secret sources before --version;
# their installed distribution metadata is the equivalent side-effect-free
# health signal.
require "open3"

module AgentConfigHarnessProbe
  module_function

  def command_for(metadata, command)
    return [command, "--version"] unless metadata["version_probe"] == "metadata"

    python = python_interpreter_for(command)
    return [python, "-c", "import importlib.metadata as m; print(m.version('hermes-agent'))"] if python

    [command, "--version"]
  end

  def python_interpreter_for(command)
    executable = resolved_executable(command)
    candidates = [executable]
    begin
      wrapper = File.read(executable)
      target = wrapper[/\bexec\s+["']([^"']+)["']/, 1]
      candidates.unshift(target) if target && !target.empty?
    rescue StandardError
      # A binary or unreadable wrapper falls back to the normal probe.
    end

    candidates.compact.uniq.each do |candidate|
      next unless File.file?(candidate)

      first_line = File.foreach(candidate).first
      next unless first_line&.start_with?("#!")

      interpreter = first_line.delete_prefix("#!").strip.split.last
      next unless interpreter&.match?(/python(?:[0-9]+(?:\.[0-9]+)?)?\z/)
      return interpreter if File.executable?(interpreter)
    rescue StandardError
      next
    end
    nil
  end

  def resolved_executable(command)
    output, _error, status = Open3.capture3("which", command)
    status.success? && !output.lines.first.to_s.strip.empty? ? output.lines.first.strip : command
  rescue StandardError
    command
  end
end
