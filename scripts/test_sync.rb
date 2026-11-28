#!/usr/bin/env ruby

require "fileutils"
require "find"
require "json"
require "open3"
require "pathname"
require "tmpdir"
require "yaml"
require_relative "path_containment"

STORE_ROOT = File.expand_path("..", __dir__)
SYNC_COMMAND = File.join(STORE_ROOT, "scripts", "sync.rb")
# The generated file trees below come from one seed, so a failing case reproduces.
SEED = 20_261_126

def run(*args)
  stdout, stderr, status = Open3.capture3(*args)
  abort "command failed: #{args.join(" ")}\n#{stdout}\n#{stderr}" unless status.success?
  stdout
end

def init_target(target)
  run("git", "init", "-q", "-b", "main", target)
  run("git", "-C", target, "config", "user.email", "test@example.invalid")
  run("git", "-C", target, "config", "user.name", "agent-configs test")
  run("git", "-C", target, "commit", "--allow-empty", "-qm", "init")
end

def commit_link(target, link, points_to)
  FileUtils.mkdir_p(File.dirname(File.join(target, link)))
  File.symlink(points_to, File.join(target, link))
  run("git", "-C", target, "add", link)
  run("git", "-C", target, "commit", "-qm", "test: add #{link}")
end

# Runs a sync that must be refused, and returns the refused target's JSON result.
def refused_sync(target, *extra)
  stdout, stderr, status = Open3.capture3(STORE_ROOT + "/bin/agent-store", "sync", "--target", target, "--json", *extra)
  abort "sync through a symbolic link exited 0: #{stdout}#{stderr}" if status.success?
  result = JSON.parse(stdout).fetch("targets").first
  abort "sync through a symbolic link was not refused: #{stdout}" unless result["status"] == "refused" && result["changes"].empty?
  result
end

# The property tests generate file trees and keep a record of what they put at each
# relative path: :dir, :file or :link. The expected answers come from that record,
# never from reading the file system back. A path is unsafe when a component that
# exists is a link, or when a component above the last one is not a folder.
def recorded_hazard?(record, relative_path)
  segments = relative_path.split("/")
  segments.each_index do |index|
    case record[segments[0..index].join("/")]
    when nil then return false
    when :link then return true
    when :file then return index < segments.length - 1
    end
  end
  false
end

# Where a generated link points, for a link at `link` in the tree at `root`.
def link_target(kind, root, link, outside)
  case kind
  when :outside_folder then File.join(outside, "folder")
  when :outside_file then File.join(outside, "file.txt")
  when :inside_folder then Pathname.new(File.join(root, "elsewhere")).relative_path_from(Pathname.new(File.dirname(link))).to_s
  when :inside_file then File.join(root, "elsewhere", "note.txt")
  when :parent then ".."
  else "missing"
  end
end

LINK_KINDS = %i[outside_folder outside_file inside_folder inside_file parent dangling].freeze

# Writes the recorded tree under root. Every tree has a real folder, elsewhere/, for
# links that point inside it.
def write_tree(root, record, links, outside)
  FileUtils.mkdir_p(File.join(root, "elsewhere"))
  File.write(File.join(root, "elsewhere", "note.txt"), "inside the tree\n")
  record.sort.each do |path, kind|
    full = File.join(root, path)
    case kind
    when :dir then FileUtils.mkdir_p(full)
    when :file then File.write(full, "#{path} before sync\n")
    when :link then File.symlink(link_target(links.fetch(path), root, full, outside), full)
    end
  end
end

# Every entry under root except .git, without following links.
def snapshot(root)
  entries = {}
  Find.find(root) do |path|
    next if path == root
    relative = path.delete_prefix("#{root}/")
    Find.prune if relative == ".git"
    stat = File.lstat(path)
    entries[relative] = if stat.symlink? then [:link, File.readlink(path)]
                        elsif stat.directory? then [:dir]
                        else [:file, File.binread(path)]
                        end
  end
  entries
end

Dir.mktmpdir("agent-configs-sync-test") do |root|
  clean = File.join(root, "clean")
  dirty = File.join(root, "dirty")

  [clean, dirty].each { |target| init_target(target) }

  FileUtils.touch(File.join(dirty, "uncommitted.txt"))

  plan = run(STORE_ROOT + "/bin/agent-store", "sync", "--target", clean, "--json")
  abort "clean target did not produce a plan" unless plan.include?("shared/provider-routing")
  abort "plan unexpectedly applied files" if File.exist?(File.join(clean, ".agent-configs"))

  run(STORE_ROOT + "/bin/agent-store", "sync", "--target", clean, "--apply")
  expected = File.join(clean, ".agent-configs", "mcp", "registry.yaml")
  abort "manifest item was not applied" unless File.file?(expected)

  run("git", "-C", clean, "add", ".agent-configs")
  run("git", "-C", clean, "commit", "-qm", "test: apply agent config sync")
  stable = run(STORE_ROOT + "/bin/agent-store", "sync", "--target", clean)
  abort "clean target was not stable after apply" unless stable.include?("planned") && !stable.include?("add:")

  dirty_result = run(STORE_ROOT + "/bin/agent-store", "sync", "--target", dirty)
  abort "dirty target was not skipped" unless dirty_result.include?("skipped-dirty")

  # A committed symbolic link at .agent-configs: the plan and the apply both refuse the
  # target, report why, and write nothing where the link points.
  linked = File.join(root, "linked")
  outside = File.join(root, "outside")
  FileUtils.mkdir_p(outside)
  init_target(linked)
  commit_link(linked, ".agent-configs", outside)
  [[], ["--apply"]].each do |extra|
    result = refused_sync(linked, *extra)
    refusal = result["refused"].first
    abort "refusal does not name .agent-configs: #{result.inspect}" unless refusal && refusal["reason"] == ".agent-configs is a symbolic link"
  end
  _stdout, stderr, status = Open3.capture3(STORE_ROOT + "/bin/agent-store", "sync", "--target", linked, "--apply", "--prune")
  abort "prune through a symbolic link exited 0: #{stderr}" if status.success?
  text, _stderr, _status = Open3.capture3(STORE_ROOT + "/bin/agent-store", "sync", "--target", linked)
  abort "plan output does not report the refusal: #{text}" unless text.include?("refused: .agent-configs/sync.yml (.agent-configs is a symbolic link)")
  abort "sync wrote through a symbolic link at .agent-configs" unless Dir.empty?(outside)

  # A symbolic link deeper down refuses the whole target too, so the items that would
  # stay inside are not written either.
  nested = File.join(root, "nested")
  elsewhere = File.join(root, "elsewhere")
  FileUtils.mkdir_p(elsewhere)
  init_target(nested)
  commit_link(nested, ".agent-configs/providers", elsewhere)
  result = refused_sync(nested, "--apply")
  refused = result["refused"].map { |item| item["destination"] }
  abort "nested link refusals are wrong: #{refused.inspect}" unless refused.any? && refused.all? { |path| path.start_with?(".agent-configs/providers/") }
  abort "a refused target still received files" if File.exist?(File.join(nested, ".agent-configs", "mcp"))
  abort "sync wrote through a nested symbolic link" unless Dir.empty?(elsewhere)
end

random = Random.new(SEED)

# Property test 1: PathContainment.refusal on generated trees of folders, files and
# links up to three levels deep. Links point inside the tree, outside it, at nothing,
# or at their own folder's parent. Each tree is reached directly and through a link to
# it, and a path must be refused exactly when the record shows a hazard on it. A path
# that climbs out with `..` to a sibling whose name extends the root's (t and tx) must
# be refused; one that climbs out and back into the root gets the answer for the rest.
refusals = Hash.new(0)
Dir.mktmpdir("agent-configs-refusal-property") do |scratch|
  outside = File.join(scratch, "outside")
  FileUtils.mkdir_p(File.join(outside, "folder"))
  File.write(File.join(outside, "file.txt"), "outside\n")
  names = %w[.agent-configs a b]
  200.times do |tree|
    base = File.join(scratch, "tree-#{tree}")
    root = File.join(base, "t")
    FileUtils.mkdir_p([root, File.join(base, "tx")])
    File.symlink(root, File.join(base, "alias"))
    record = {}
    links = {}
    grow = lambda do |relative, level|
      names.each do |name|
        path = relative.empty? ? name : "#{relative}/#{name}"
        roll = random.rand
        if roll < 0.35 && level < 3
          record[path] = :dir
          grow.call(path, level + 1)
        elsif roll < 0.5
          record[path] = :file
        elsif roll < 0.75
          record[path] = :link
          links[path] = LINK_KINDS.sample(random: random)
        end
      end
    end
    grow.call("", 1)
    write_tree(root, record, links, outside)

    relative_path = ->(length) { Array.new(length) { (names + ["new"]).sample(random: random) }.join("/") }
    cases = []
    30.times do
      relative = relative_path.call(1 + random.rand(4))
      unsafe = recorded_hazard?(record, relative)
      cases << [root, relative, unsafe] << [File.join(base, "alias"), relative, unsafe]
    end
    4.times do
      rest = relative_path.call(1 + random.rand(3))
      cases << [root, "../tx/#{rest}", true] << [root, "../t/#{rest}", recorded_hazard?(record, rest)]
    end
    cases.each do |given, relative, unsafe|
      reason = PathContainment.refusal(given, relative)
      unless reason.nil? == !unsafe
        abort "refusal disagrees with the generated tree (seed #{SEED}, tree #{tree}): #{relative} under #{given} gave #{reason.inspect}; record #{record.inspect}, links #{links.inspect}"
      end
      refusals[reason ? reason[/symbolic link|not a folder|outside the target/] : "accepted"] += 1
    end
  end
end
{ "accepted" => 4_000, "symbolic link" => 1_200, "not a folder" => 600, "outside the target" => 800 }.each do |kind, minimum|
  abort "the generated refusal cases are lopsided (#{kind}: #{refusals[kind]}, want #{minimum}): #{refusals.inspect}" if refusals[kind] < minimum
end

# Property test 2: sync itself, on generated target checkouts. A scratch store holds
# copies of sync.rb and path_containment.rb and a manifest whose items nest up to four
# folders deep and whose deletions reach --prune. Along those paths each target gets
# folders, missing folders, existing files, files where a folder belongs and links, all
# committed so the checkout is clean. The first targets each get one hazard chosen to
# cover every refusal, and some targets are reached through a link to them. A plan, then
# an --apply --prune run, must refuse exactly the targets with a hazard on a path that
# run uses, leave refused targets and everything outside the targets unchanged, and give
# every other target the manifest's files and deletions and nothing else.
targets = []
Dir.mktmpdir("agent-configs-sync-property") do |scratch|
  scratch = File.realpath(scratch)
  outside = File.join(scratch, "outside")
  FileUtils.mkdir_p(File.join(outside, "folder"))
  File.write(File.join(outside, "file.txt"), "outside\n")

  items = {
    "test/top" => ".agent-configs/top.yaml",
    "test/one" => ".agent-configs/a/one.yaml",
    "test/two" => ".agent-configs/a/b/two.yaml",
    "test/three" => ".agent-configs/a/b/c/three.yaml",
    "test/side" => ".agent-configs/s/side.yaml",
  }
  deletions = [".agent-configs/old.yaml", ".agent-configs/a/old", ".agent-configs/s/t/old.yaml"]
  policy_file = ".agent-configs/sync.yml"
  store = File.join(scratch, "store")
  FileUtils.mkdir_p([File.join(store, "scripts"), File.join(store, "sync"), File.join(store, "sources")])
  FileUtils.cp([SYNC_COMMAND, File.join(STORE_ROOT, "scripts", "path_containment.rb")], File.join(store, "scripts"))
  manifest_items = items.map do |id, destination|
    source = "sources/#{id.split("/").last}.yaml"
    File.write(File.join(store, source), "#{id}: from the store\n")
    { "id" => id, "version" => 1, "source" => source, "destination" => destination, "groups" => ["shared"] }
  end
  manifest = {
    "version" => 1,
    "policy" => { "default_groups" => ["shared"], "target_policy_file" => policy_file },
    "items" => manifest_items,
    "deletions" => deletions.map { |destination| { "destination" => destination, "reason" => "test" } },
  }
  File.write(File.join(store, "sync", "manifest.yaml"), YAML.dump(manifest))
  sources = manifest_items.to_h { |item| [item["id"], File.binread(File.join(store, item["source"]))] }

  leaves = items.values + deletions + [policy_file]
  nodes = leaves.flat_map { |path| segments = path.split("/"); (1..segments.length).map { |count| segments.first(count).join("/") } }.uniq.sort
  forced = [
    [".agent-configs", :link, :outside_folder],
    [".agent-configs", :link, :inside_folder],
    [".agent-configs/a/b", :link, :outside_folder],
    [".agent-configs/a/b/c/three.yaml", :link, :outside_file],
    [".agent-configs/top.yaml", :link, :dangling],
    [".agent-configs/s/side.yaml", :link, :inside_file],
    [".agent-configs/a", :file, nil],
    [".agent-configs/s/t", :link, :outside_folder],
    [".agent-configs/old.yaml", :link, :outside_file],
    [policy_file, :link, :outside_file],
  ]
  60.times do |index|
    record = {}
    links = {}
    nodes.each do |node|
      next unless File.dirname(node) == "." || record[File.dirname(node)] == :dir
      roll = random.rand
      if !leaves.include?(node)
        record[node] = :dir if roll < 0.9 || index < forced.length
      elsif node != policy_file && roll < 0.5
        record[node] = node == ".agent-configs/a/old" && roll < 0.25 ? :dir : :file
      end
    end
    hazards = index < forced.length ? [forced[index]] : []
    if index >= forced.length
      nodes.each do |node|
        next unless (File.dirname(node) == "." || record[File.dirname(node)] == :dir) && random.rand < 0.04
        hazard = !leaves.include?(node) && random.rand < 0.3 ? [node, :file, nil] : [node, :link, LINK_KINDS.sample(random: random)]
        hazards << hazard
        record.delete_if { |path, _| path.start_with?("#{node}/") }
        record[node] = hazard[1]
      end
    end
    hazards.each do |node, kind, link|
      record.delete_if { |path, _| path.start_with?("#{node}/") }
      record[node] = kind
      links[node] = link if link
    end

    real = File.join(scratch, "targets", format("t%02d", index))
    FileUtils.mkdir_p(real)
    write_tree(real, record, links, outside)
    File.write(File.join(real, ".agent-configs", "a", "old", "inside.txt"), "to delete\n") if record[".agent-configs/a/old"] == :dir
    given = real
    if index % 5 == 4
      given = File.join(scratch, "aliases", format("a%02d", index))
      FileUtils.mkdir_p(File.dirname(given))
      File.symlink(real, given)
    end
    targets << { name: File.basename(given), given: given, real: real, record: record, before: snapshot(real) }
  end
  # Starting git is the slow part, so six targets are committed at a time.
  queue = Queue.new
  targets.each { |target| queue << target[:real] }
  queue.close
  Array.new(6) do
    Thread.new do
      while (real = queue.pop)
        run("git", "init", "-q", "-b", "main", real)
        run("git", "-C", real, "add", "-A")
        run("git", "-C", real, "-c", "user.email=test@example.invalid", "-c", "user.name=agent-configs test", "commit", "-qm", "generated tree")
      end
    end
  end.each(&:join)

  outside_before = snapshot(outside)
  sync = [RbConfig.ruby, File.join(store, "scripts", "sync.rb"), "--json", "--backup-dir", File.join(scratch, "backups")]
  targets.each { |target| sync.push("--target", target[:given]) }
  reasons = []
  [[[], items.values + [policy_file], "planned"], [["--apply", "--prune"], leaves, "applied"]].each do |extra, used, done|
    stdout, stderr, status = Open3.capture3(*sync, *extra)
    results = JSON.parse(stdout).fetch("targets").to_h { |result| [result["name"], result] }
    refused_any = false
    targets.each do |target|
      unsafe = used.any? { |path| recorded_hazard?(target[:record], path) }
      refused_any ||= unsafe
      (target[:refused] ||= []) << unsafe
      result = results.fetch(target[:name])
      unless result["status"] == (unsafe ? "refused" : done)
        abort "sync #{extra.join(" ")} gave #{result["status"]} for a generated target (seed #{SEED}, #{target[:name]}); record #{target[:record].inspect}: #{result.inspect}"
      end
      expected = target[:before]
      if done == "applied" && !unsafe
        expected = expected.dup
        items.each do |id, destination|
          segments = destination.split("/")
          (1...segments.length).each { |count| expected[segments.first(count).join("/")] ||= [:dir] }
          expected[destination] = [:file, sources.fetch(id)]
        end
        deletions.each { |destination| expected.delete_if { |path, _| path == destination || path.start_with?("#{destination}/") } }
      end
      after = snapshot(target[:real])
      unless after == expected
        abort "sync #{extra.join(" ")} left a generated target in the wrong state (seed #{SEED}, #{target[:name]}): got #{after.keys.sort.inspect}, want #{expected.keys.sort.inspect}"
      end
      abort "a refused target reports a backup that was never made: #{result.inspect}" if unsafe && result.key?("backup")
      result["refused"].each { |refusal| reasons << [refusal["id"], refusal["reason"]] } if done == "applied"
    end
    abort "sync #{extra.join(" ")} exited #{status.exitstatus}: #{stderr}" unless status.exitstatus == (refused_any ? 1 : 0)
    abort "sync #{extra.join(" ")} changed files outside the targets" unless snapshot(outside) == outside_before
  end

  applied = targets.reject { |target| target[:refused].last }
  coverage = {
    "refused by the plan" => targets.count { |target| target[:refused].first },
    "refused only by --prune" => targets.count { |target| target[:refused] == [false, true] },
    "applied" => applied.length,
    "applied with a deletion" => applied.count { |target| deletions.any? { |destination| target[:before].key?(destination) } },
    "applied through a link to the target" => applied.count { |target| target[:given] != target[:real] },
    "refused at a symbolic link" => reasons.count { |_, reason| reason.end_with?("is a symbolic link") },
    "refused at a file where a folder belongs" => reasons.count { |_, reason| reason.end_with?("is not a folder") },
    "refused at the target policy file" => reasons.count { |id, _| id == "target-policy" },
    "refused at a deletion" => reasons.count { |id, _| id.start_with?("deletion/") },
  }
  coverage.each { |kind, count| abort "the generated targets never covered: #{kind} (#{coverage.inspect})" if count.zero? }
end

puts "sync smoke tests passed (#{refusals.values.sum} generated refusal cases, #{targets.length} generated targets)"
