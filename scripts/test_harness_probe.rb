require "tmpdir"
require_relative "harness_probe"

Dir.mktmpdir("agent-configs-harness-probe") do |root|
  python = File.join(root, "python3")
  runtime = File.join(root, "hermes-runtime")
  hermes = File.join(root, "hermes")
  File.write(python, "#!/bin/sh\n")
  File.chmod(0o755, python)
  File.write(runtime, "#!#{python}\n")
  File.chmod(0o755, runtime)
  File.write(hermes, "#!/bin/sh\nexec #{runtime.inspect} \"$@\"\n")
  File.chmod(0o755, hermes)

  # The fixture's interpreter is intentionally not a real Python executable;
  # the resolver should still identify the nested wrapper target by its shebang.
  probe = AgentConfigHarnessProbe.command_for({ "version_probe" => "metadata" }, hermes)
  abort "metadata probe did not resolve the wrapper interpreter" unless probe.first == python
  abort "ordinary probe changed" unless AgentConfigHarnessProbe.command_for({}, "demo") == ["demo", "--version"]
end

puts "harness probe tests: ok"
