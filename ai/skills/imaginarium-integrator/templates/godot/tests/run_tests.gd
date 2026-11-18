extends SceneTree
## Headless smoke tests for the game (imaginarium_engine.mjs test runs res://tests/run_tests.gd automatically):
##   godot --headless --path <project> --script res://tests/run_tests.gd
## PLAYER_SCENE is set by the agent to the Imaginarium package of the playable character. Exit code = failures.

const PLAYER_SCENE := "res://imaginarium/__PLAYER_ID__/__PLAYER_ID__.tscn"
const PLAYER_SCRIPT := "res://scripts/player_controller.gd"

var _failed := 0
var _passed := 0


func _initialize() -> void:
	_run.call_deferred()


func _check(cond: bool, what: String) -> void:
	if cond:
		_passed += 1
		print("PASS  ", what)
	else:
		_failed += 1
		printerr("FAIL  ", what)


func _make_player() -> CharacterBody3D:
	var body := CharacterBody3D.new()
	body.set_script(load(PLAYER_SCRIPT))
	body.model_scene = load(PLAYER_SCENE)
	body.read_input = false
	root.add_child(body)
	body.setup()
	return body


func _run() -> void:
	_check(ResourceLoader.exists(PLAYER_SCENE), "player package exists: %s" % PLAYER_SCENE)
	if _failed:
		_finish()
		return
	var p := _make_player()
	await process_frame
	_check(p.find_children("*", "AnimationPlayer", true, false).size() > 0, "player has an AnimationPlayer")
	var start := p.global_position
	p.input_vector = Vector2(0.0, 1.0)
	for i in 30:
		p.tick(1.0 / 30.0)
		await process_frame   # move_and_slide advances by the frame step: give every tick a real frame
	var moved := Vector2(p.global_position.x - start.x, p.global_position.z - start.z).length()
	_check(moved > 1.0, "player moves on the ground plane (%.2f m in 30 ticks)" % moved)
	_check(p.current_anim == p.move_anim, "move animation plays (%s)" % p.current_anim)
	p.input_vector = Vector2.ZERO
	p.tick(1.0 / 30.0)
	_check(p.current_anim == p.idle_anim, "idle animation when standing (%s)" % p.current_anim)
	var main := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main != "":
		var scene = load(main)
		_check(scene is PackedScene and (scene as PackedScene).instantiate() != null, "main scene instances: %s" % main)
	_finish()


func _finish() -> void:
	print("TESTS passed=%d failed=%d" % [_passed, _failed])
	quit(_failed)
