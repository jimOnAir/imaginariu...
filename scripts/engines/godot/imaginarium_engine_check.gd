extends SceneTree
## Imaginarium: background check of a Godot project (imaginarium_engine.mjs test).
##   godot --headless --path <project> --script res://.imaginarium_check.gd -- --out=<json> [--frames=120] [--scene=res://...]
## Every scene under res://imaginarium and res://scenes (or the one --scene) is loaded, instanced and run for N frames;
## the JSON lists load/instance, node and mesh counts, the size of the visible geometry, animations with loop modes.
## Engine errors are taken from the process output by the caller.
##   godot --path <project> --position -30000,-30000 --script ... -- --shot=<png> --scene=res://...  renders one frame
## (a real window off-screen: --headless has no renderer); a camera and light are added when the scene has none.

var _args := {}


func _initialize() -> void:
	for a in OS.get_cmdline_user_args():
		var kv := a.trim_prefix("--").split("=", true, 1)
		_args[kv[0]] = kv[1] if kv.size() > 1 else "true"
	_run.call_deferred()


func _scenes() -> Array[String]:
	var out: Array[String] = []
	if _args.has("scene"):
		out.append(_args["scene"])
		return out
	for root in ["res://imaginarium", "res://scenes"]:
		_collect(root, out)
	var main := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main != "" and not out.has(main):
		out.append(main)
	return out


func _collect(dir_path: String, out: Array[String]) -> void:
	var d := DirAccess.open(dir_path)
	if d == null:
		return
	for f in d.get_files():
		if f.ends_with(".tscn") and not dir_path.ends_with("/fx"):
			out.append(dir_path.path_join(f))
	for sub in d.get_directories():
		if not sub.begins_with("."):
			_collect(dir_path.path_join(sub), out)


func _bounds(n: Node) -> Array:
	var box := AABB()
	var have := false
	var meshes := 0
	for c in n.find_children("*", "VisualInstance3D", true, false):
		var vi := c as VisualInstance3D
		if vi is GPUParticles3D or vi is Light3D:
			continue
		var b: AABB = vi.global_transform * vi.get_aabb()
		if b.size.length() <= 0.0:
			continue
		meshes += 1
		box = b if not have else box.merge(b)
		have = true
	return [box, meshes]


func _animations(n: Node) -> Dictionary:
	var out := {}
	for c in n.find_children("*", "AnimationPlayer", true, false):
		var ap := c as AnimationPlayer
		for name in ap.get_animation_list():
			out[str(name)] = ap.get_animation(name).loop_mode
	return out


func _run() -> void:
	if _args.has("shot"):
		await _shot()
		return
	var frames := int(_args.get("frames", "120"))
	var report := {"ok": true, "scenes": [], "godot": Engine.get_version_info().string}
	for path in _scenes():
		var row := {"path": path, "ok": false}
		var res = ResourceLoader.load(path)
		if res == null or not (res is PackedScene):
			row["error"] = "not loaded"
			report["ok"] = false
			report["scenes"].append(row)
			continue
		var inst: Node = (res as PackedScene).instantiate()
		if inst == null:
			row["error"] = "not instanced"
			report["ok"] = false
			report["scenes"].append(row)
			continue
		root.add_child(inst)
		for i in frames:
			await process_frame
		var b := _bounds(inst)
		var box: AABB = b[0]
		row["ok"] = true
		row["nodes"] = inst.find_children("*", "", true, false).size() + 1
		row["meshes"] = b[1]
		row["size_m"] = [snappedf(box.size.x, 0.001), snappedf(box.size.y, 0.001), snappedf(box.size.z, 0.001)]
		row["animations"] = _animations(inst)
		row["frames"] = frames
		report["scenes"].append(row)
		inst.queue_free()
		await process_frame
	if report["scenes"].is_empty():
		report["note"] = "no scenes under res://imaginarium or res://scenes"
	var f := FileAccess.open(_args.get("out", "user://imaginarium_engine_check.json"), FileAccess.WRITE)
	f.store_string(JSON.stringify(report, " "))
	f.close()
	print("AFENGINE ", JSON.stringify({"ok": report["ok"], "scenes": report["scenes"].size()}))
	quit(0 if report["ok"] else 1)


func _shot() -> void:
	var res = ResourceLoader.load(_args.get("scene", ""))
	if not (res is PackedScene):
		quit(1)
		return
	var inst: Node = (res as PackedScene).instantiate()
	root.add_child(inst)
	await process_frame
	var b := _bounds(inst)
	var box: AABB = b[0]
	if inst.find_children("*", "Camera3D", true, false).is_empty():
		var cam := Camera3D.new()
		root.add_child(cam)
		var center := box.get_center()
		var radius := maxf(0.1, box.size.length() * 0.5)
		var dir := Vector3(0.55, 0.42, 1.0).normalized()
		cam.fov = 30.0
		cam.position = center + dir * radius / sin(deg_to_rad(15.0)) * 1.05
		cam.look_at(center)
		cam.current = true
	if inst.find_children("*", "DirectionalLight3D", true, false).is_empty():
		var sun := DirectionalLight3D.new()
		sun.rotation_degrees = Vector3(-48, -35, 0)
		sun.shadow_enabled = true
		root.add_child(sun)
		var env := WorldEnvironment.new()
		env.environment = Environment.new()
		env.environment.background_mode = Environment.BG_COLOR
		env.environment.background_color = Color(0.56, 0.63, 0.72)
		env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
		env.environment.ambient_light_color = Color(0.6, 0.62, 0.68)
		root.add_child(env)
	for i in 30:
		await process_frame
	await RenderingServer.frame_post_draw
	var img := root.get_viewport().get_texture().get_image()
	img.save_png(_args["shot"])
	quit(0)
