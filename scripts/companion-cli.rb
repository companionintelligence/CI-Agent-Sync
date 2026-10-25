#!/usr/bin/env ruby

# A small bridge around the native Companion Hub (`cihub`) and Companion
# Memory (`ci`) CLIs. Agent Atlas owns portable policy and safe orchestration;
# the native products remain the source of truth for their own commands.
#
# The bridge is intentionally dependency-free. It discovers installed CLIs,
# falls back to a local checkout when one is available, keeps credentials in
# the inherited environment/1Password wrappers, and never prints credential
# values or shell-evaluated command strings.

require "json"
require "English"
require "optparse"
require "open3"
require "shellwords"
require "time"
require_relative "process_helpers"

ROOT = File.expand_path("..", __dir__)

module CompanionCli
  Surface = Struct.new(:id, :command, :cwd, :executable, :description, keyword_init: true)

  class Runner
    def initialize(env: ENV, out: $stdout, err: $stderr)
      @env = env
      @out = out
      @err = err
    end

    attr_reader :env

    def hub_surface
      override_surface(
        "companion-hub",
        @env["CIHUB_BIN"].to_s.strip.empty? ? @env["COMPANION_HUB_CLI"] : @env["CIHUB_BIN"],
      ) || begin
        executable = find_executable("cihub")
        if executable
          Surface.new(id: "companion-hub", command: [executable], executable: executable, description: "cihub")
        else
          repo = find_repo(%w[Companion-Hub CI-Hub], %w[bin/cihub.cjs])
          node = find_executable("node")
          entrypoint = repo && File.join(repo, "bin", "cihub.cjs")
          if entrypoint && File.file?(entrypoint) && node
            Surface.new(
              id: "companion-hub",
              command: [node, entrypoint],
              cwd: repo,
              executable: entrypoint,
              description: "local Companion-Hub checkout",
            )
          end
        end
      end
    end

    def memory_surface
      override_surface(
        "companion-memory",
        @env["CI_MEMORY_CLI"].to_s.strip.empty? ? @env["COMPANION_MEMORY_CLI"] : @env["CI_MEMORY_CLI"],
      ) || begin
        executable = find_executable("ci")
        if executable
          Surface.new(id: "companion-memory", command: [executable], executable: executable, description: "ci")
        else
          repo = find_repo(%w[CI-Memory Companion-Memory], %w[backend/apps/cli/package.json])
          node = find_executable("node")
          built = repo && File.join(repo, "backend", "apps", "cli", "dist", "ci.cjs")
          if built && File.file?(built) && node
            Surface.new(
              id: "companion-memory",
              command: [node, built],
              cwd: repo,
              executable: built,
              description: "built Companion-Memory CLI",
            )
          else
            yarn = find_executable("yarn")
            corepack = find_executable("corepack")
            package_manager = if yarn
                                [yarn]
                              elsif corepack
                                [corepack, "yarn"]
                              end
            if repo && package_manager
              Surface.new(
                id: "companion-memory",
                command: package_manager + ["workspace", "@ci/cli", "dev"],
                cwd: repo,
                executable: package_manager.first,
                description: "Companion-Memory checkout via Yarn",
              )
            end
          end
        end
      end
    end

    def run(surface, args, timeout_seconds: 30, from_1password: false)
      command = command_with_credentials(surface.command + args, "companion-memory") if from_1password
      command ||= surface.command + args
      output = ""
      error = ""
      status = nil

      begin
        if surface.cwd
          Dir.chdir(surface.cwd) do
            output, error, status = AgentConfigProcess.capture_with_timeout(command, timeout_seconds)
          end
        else
          output, error, status = AgentConfigProcess.capture_with_timeout(command, timeout_seconds)
        end
      rescue Errno::ENOENT
        error = "command not found"
      rescue StandardError => caught
        error = "#{caught.class}: #{caught.message}"
      end

      exit_code = status&.exitstatus
      result_status = if status&.success?
                        "ok"
                      else
                        "error"
                      end
      detail = if status.nil? && output.to_s.empty? && error.to_s.empty?
                 "timed out or did not exit within #{timeout_seconds}s"
               else
                 safe_detail(output.empty? ? error : output)
               end

      {
        "id" => surface.id,
        "status" => result_status,
        "exit_code" => exit_code,
        "command" => Shellwords.join(command),
        "executable" => surface.executable,
        "description" => surface.description,
        "detail" => detail,
        "payload" => parse_payload(output),
      }.reject { |_key, value| value.nil? || value == "" }
    end

    def stream(surface, args, from_1password: false)
      command = command_with_credentials(surface.command + args, "companion-memory") if from_1password
      command ||= surface.command + args
      status = if surface.cwd
                 system(*command, chdir: surface.cwd)
               else
                 system(*command)
               end
      status ? 0 : ($CHILD_STATUS&.exitstatus || 1)
    rescue Errno::ENOENT
      @err.puts "#{surface.id} CLI could not be started: #{surface.description} was not found."
      127
    end

    def missing_message(id)
      case id
      when "companion-hub"
        "cihub is not installed; install Companion Hub or set CIHUB_BIN/COMPANION_HUB_CLI"
      when "companion-memory"
        "ci is not installed and no Companion-Memory checkout was found; set CI_MEMORY_ROOT or CI_MEMORY_CLI"
      else
        "native CLI is not available"
      end
    end

    private

    def command_with_credentials(command, provider)
      [File.join(ROOT, "bin", "agent-store"), "with", provider, "--", *command]
    end

    def override_surface(id, value)
      return nil if value.to_s.strip.empty?

      tokens = if File.file?(value) && File.executable?(value)
                 [value]
               else
                 Shellwords.split(value)
               end
      return nil if tokens.empty?

      Surface.new(id: id, command: tokens, executable: tokens.first, description: "configured override")
    rescue ArgumentError
      nil
    end

    def find_executable(name)
      return name if name.include?(File::SEPARATOR) && File.executable?(name)

      @env.fetch("PATH", "").split(File::PATH_SEPARATOR).each do |directory|
        candidate = File.join(directory, name)
        return candidate if File.file?(candidate) && File.executable?(candidate)
      end
      nil
    end

    def workspace_roots
      configured = @env["CI_ROOT"].to_s.strip
      inferred = [
        File.expand_path("../..", __dir__),
        File.expand_path("../../..", __dir__),
        File.expand_path("~/devel/ci"),
      ]
      ([configured] + inferred).reject(&:empty?).map { |path| File.expand_path(path) }.uniq
    end

    def find_repo(names, required_files)
      explicit = names.first == "Companion-Hub" ? @env["CI_HUB_ROOT"] : @env["CI_MEMORY_ROOT"]
      candidates = []
      candidates << explicit unless explicit.to_s.strip.empty?
      workspace_roots.each do |base|
        names.each do |name|
          candidates << File.join(base, name)
        end
        candidates << File.join(base, "0-HUB", names.first)
      end
      candidates.uniq.find do |candidate|
        File.directory?(candidate) && required_files.all? { |relative| File.file?(File.join(candidate, relative)) }
      end
    end

    def safe_detail(value)
      cleaned = value.to_s.gsub(/\e\[[0-?]*[ -\/]*[@-~]/, "")
      cleaned = cleaned.gsub(/(api[_-]?key|token|password|secret|authorization)\s*([:=])\s*([^\s,}]+)/i) do
        "#{$1}#{$2}[REDACTED]"
      end
      cleaned = cleaned.gsub(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/i, "\\1[REDACTED]")
      cleaned.lines.last(20).join.strip[0, 4_000]
    end

    def parse_payload(output)
      parsed = JSON.parse(output)
      parsed if parsed.is_a?(Hash) || parsed.is_a?(Array)
    rescue JSON::ParserError, TypeError
      nil
    end
  end

  class Application
    def initialize(argv, env: ENV, out: $stdout, err: $stderr)
      @argv = argv.dup
      @runner = Runner.new(env: env, out: out, err: err)
      @out = out
      @err = err
    end

    def run
      target = @argv.shift
      case target
      when nil, "help", "--help", "-h"
        puts_usage
        0
      when "status"
        status_command(@argv)
      when "hub"
        passthrough(:hub, @argv)
      when "memory"
        passthrough(:memory, @argv)
      when "tui"
        tui_command(@argv)
      else
        @err.puts "Unknown companion target: #{target}"
        puts_usage(@err)
        2
      end
    end

    private

    def puts_usage(io = @out)
      io.puts <<~USAGE
        agentctl companion — bridge Agent Atlas with Companion Hub and Memory

        Usage:
          agentctl companion status [options]
          agentctl companion hub [cihub arguments...]
          agentctl companion memory [--from-1password] [ci arguments...]
          agentctl companion tui [--once]

        Examples:
          agentctl companion status --json
          agentctl companion hub status local
          agentctl companion hub pool status local
          agentctl companion memory status
          agentctl companion memory doctor --graphql
          agentctl companion memory stats --json
          agentctl companion tui

        Native CLI discovery:
          Hub:    cihub, CIHUB_BIN, CI_HUB_ROOT
          Memory: ci, CI_MEMORY_CLI, CI_MEMORY_ROOT, or a local CI-Memory checkout

        The bridge never accepts or prints credential values. Native commands
        retain their own confirmation and mutation policies.
      USAGE
    end

    def parse_status_options(argv)
      options = {
        json: false,
        strict: false,
        env: @runner.env.fetch("CI_HUB_ENV", "local"),
        memory_server: @runner.env["COMPANION_MEMORY_BASE_URL"].to_s.strip,
        timeout: 30,
        hub: true,
        memory: true,
        from_1password: false,
      }
      parser = OptionParser.new do |command|
        command.banner = "Usage: agentctl companion status [options]"
        command.on("--json", "machine-readable output") { options[:json] = true }
        command.on("--strict", "return nonzero when a CLI is missing") { options[:strict] = true }
        command.on("--env ENV", "Companion Hub environment (default: local)") { |value| options[:env] = value }
        command.on("--memory-server URL", "override the Memory server passed to ci") { |value| options[:memory_server] = value }
        command.on("--timeout SECONDS", Integer, "per-CLI timeout") { |value| options[:timeout] = value }
        command.on("--no-hub", "skip Companion Hub") { options[:hub] = false }
        command.on("--no-memory", "skip Companion Memory") { options[:memory] = false }
        command.on("--from-1password", "inject the Memory key through agent-store for this run") { options[:from_1password] = true }
        command.on("--help") { puts command; exit 0 }
      end
      parser.parse!(argv)
      options[:timeout] = [[options[:timeout], 1].max, 300].min
      options
    end

    def status_command(argv)
      options = parse_status_options(argv)
      services = []
      services << run_status_surface("companion-hub", @runner.hub_surface, ["status", options[:env]], options[:timeout]) if options[:hub]

      if options[:memory]
        memory_args = []
        memory_server = options[:memory_server]
        memory_server = @runner.env["CI_SERVER_URL"].to_s.strip if memory_server.empty?
        memory_args.concat(["--server", memory_server]) unless memory_server.empty?
        memory_args.concat(["doctor", "--graphql", "--json"])
        services << run_status_surface("companion-memory", @runner.memory_surface, memory_args, options[:timeout], from_1password: options[:from_1password])
      end

      summary = services.group_by { |service| service["status"] }.transform_values(&:length)
      summary["ok"] ||= 0
      summary["warn"] ||= 0
      summary["error"] ||= 0
      result = {
        "schema_version" => 1,
        "observed_at" => Time.now.utc.iso8601,
        "mode" => "native_cli_bridge",
        "hub_environment" => options[:env],
        "summary" => summary,
        "services" => services,
      }

      if options[:json]
        @out.puts JSON.pretty_generate(result)
      else
        @out.puts "Companion CLI status (native surfaces)"
        services.each do |service|
          icon = service["status"] == "ok" ? "✓" : (service["status"] == "error" ? "✗" : "!")
          @out.puts "#{icon} #{service["id"]}: #{service["detail"]}"
          @out.puts "  #{service["description"]} · #{service["command"]}" if service["command"]
        end
        @out.puts "Summary: #{summary["ok"]} ok, #{summary["warn"]} warnings, #{summary["error"]} errors"
      end

      return 1 if summary["error"].positive?
      return 2 if options[:strict] && summary["warn"].positive?

      0
    end

    def run_status_surface(id, surface, args, timeout, from_1password: false)
      unless surface
        return {
          "id" => id,
          "status" => "warn",
          "detail" => @runner.missing_message(id),
          "suggested_action" => id == "companion-hub" ? "Install cihub or set CIHUB_BIN" : "Install @ci/cli or set CI_MEMORY_ROOT",
        }
      end

      @runner.run(surface, args, timeout_seconds: timeout, from_1password: from_1password && id == "companion-memory")
    end

    def passthrough(kind, args)
      surface = kind == :hub ? @runner.hub_surface : @runner.memory_surface
      id = kind == :hub ? "companion-hub" : "companion-memory"
      unless surface
        @err.puts @runner.missing_message(id)
        return 127
      end

      from_1password = kind == :memory ? args.delete("--from-1password") : nil
      normalized = args.dup
      if normalized.empty?
        normalized = ["--help"]
      elsif kind == :memory
        normalized = memory_alias(normalized)
      end
      @runner.stream(surface, normalized, from_1password: !from_1password.nil?)
    end

    def memory_alias(args)
      case args
      when ["status"]
        memory_server_args + ["doctor", "--graphql"]
      when ["check"]
        memory_server_args + ["memory", "check"]
      when ["llm"], ["inference"]
        memory_server_args + ["memory", "status"]
      else
        args
      end
    end

    def memory_server_args
      url = @runner.env["COMPANION_MEMORY_BASE_URL"].to_s.strip
      url = @runner.env["CI_SERVER_URL"].to_s.strip if url.empty?
      url.empty? ? [] : ["--server", url]
    end

    def tui_command(argv)
      options = { once: false, env: @runner.env.fetch("CI_HUB_ENV", "local"), timeout: 30, from_1password: false }
      parser = OptionParser.new do |command|
        command.banner = "Usage: agentctl companion tui [options]"
        command.on("--once", "run combined status and exit") { options[:once] = true }
        command.on("--env ENV", "Companion Hub environment") { |value| options[:env] = value }
        command.on("--timeout SECONDS", Integer, "per-CLI timeout") { |value| options[:timeout] = value }
        command.on("--from-1password", "pass 1Password mode to the Agent Atlas readiness probe") { options[:from_1password] = true }
        command.on("--help") { puts command; exit 0 }
      end
      parser.parse!(argv)
      options[:timeout] = [[options[:timeout], 1].max, 300].min

      if options[:once]
        args = ["--env", options[:env], "--timeout", options[:timeout].to_s]
        args << "--from-1password" if options[:from_1password]
        return status_command(args)
      end

      @out.puts "Companion Intelligence TUI"
      @out.puts "Native Hub and Memory CLIs remain authoritative; this menu is a safe launcher."
      @out.puts

      loop do
        @out.puts "[1] Combined Hub + Memory status"
        @out.puts "[2] Companion Hub status"
        @out.puts "[3] Companion Hub pool status"
        @out.puts "[4] Companion Memory connection"
        @out.puts "[5] Companion Memory inference"
        @out.puts "[6] Agent Atlas readiness"
        @out.puts "[7] Create redacted Agent Atlas backup"
        @out.puts "[q] Quit"
        @out.print "Select: "
        @out.flush
        choice = $stdin.gets&.strip
        break if choice.nil? || choice.casecmp("q").zero?

        code = case choice
               when "1"
                 status_command(["--env", options[:env], "--timeout", options[:timeout].to_s])
               when "2"
                 passthrough(:hub, ["status", options[:env]])
               when "3"
                 passthrough(:hub, ["pool", "status", options[:env]])
               when "4"
                 passthrough(:memory, ["status", ("--from-1password" if options[:from_1password])].compact)
               when "5"
                 passthrough(:memory, ["llm", ("--from-1password" if options[:from_1password])].compact)
               when "6"
                 readiness_command(options)
               when "7"
                 backup_command
               else
                 @out.puts "Choose 1–7 or q."
                 2
               end
        @out.puts "Action exit: #{code}" unless code.zero?
        @out.puts
      end
      0
    end

    def readiness_command(options)
      args = [File.join(ROOT, "scripts", "readiness.rb")]
      args << "--from-1password" if options[:from_1password]
      system(RbConfig.ruby, *args) ? 0 : ($CHILD_STATUS&.exitstatus || 1)
    end

    def backup_command
      @out.print "Type BACKUP to create a redacted snapshot: "
      @out.flush
      return 2 unless $stdin.gets.to_s.strip == "BACKUP"

      command = [RbConfig.ruby, File.join(ROOT, "scripts", "backup.rb")]
      system(*command) ? 0 : ($CHILD_STATUS&.exitstatus || 1)
    end
  end
end

exit CompanionCli::Application.new(ARGV).run
