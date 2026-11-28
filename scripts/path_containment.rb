# Path containment for sync, which must write only inside the target repository.
#
# within? is the decision childWithin makes in src/path-containment.ts, which is
# proved with LemmaScript and Dafny: a candidate is inside base only when it is
# base or starts with base followed by the separator. Both paths must be
# absolute and normalised, as File.realpath returns them. src/test.ts checks this
# copy against the TypeScript core on generated paths.
module PathContainment
  module_function

  def within?(base, candidate, separator = File::SEPARATOR)
    candidate == base || candidate.start_with?(base + separator)
  end

  # Why reading, writing or deleting relative_path under root could leave root,
  # or nil when it cannot. No existing component may be a symbolic link, every
  # existing component above the last must be a folder, and the deepest existing
  # folder must resolve inside the real root. Missing components are created by
  # the write itself, as real folders.
  def refusal(root, relative_path)
    real_root = File.realpath(root)
    segments = relative_path.split("/")
    folder = root
    path = root
    segments.each_with_index do |segment, index|
      path = File.join(path, segment)
      shown = segments[0..index].join("/")
      stat = File.lstat(path)
      return "#{shown} is a symbolic link" if stat.symlink?

      last = index == segments.length - 1
      return "#{shown} is not a folder" if !last && !stat.directory?

      folder = path unless last
    rescue Errno::ENOENT
      break
    end
    return "#{relative_path} resolves outside the target" unless within?(real_root, File.realpath(folder))

    nil
  end
end
