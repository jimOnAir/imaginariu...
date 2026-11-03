class_name PlayerController
extends CharacterBody3D
## Third-person / top-down controller for an AstraForge character package (res://astraforge/<id>/<id>.tscn):
## WASD / arrows / gamepad (the ui_* actions), turns toward the movement direction, plays idle and run (or
## walk) from the package's AnimationPlayer. tick() stays public so headless tests can drive it without
## input. Template of the astraforge-integrator skill.

@export var model_scene: PackedScene
@export var speed := 3.5
@export var turn_speed := 12.0
@export var idle_anim := "idle"
@export var move_anim := "run"
@export var read_input := true
@export var camera: Camera3D

var input_vector := Vector2.ZERO
var current_anim := ""
var _player: AnimationPlayer


func _ready() -> void:
	setup()


## Instances the model and finds its AnimationPlayer (tests call this too, before the node has run).
func setup() -> void:
	if _player != null:
		return
	if model_scene != null and get_node_or_null("model") == null:
		var m := model_scene.instantiate()
		m.name = "model"
		add_child(m)
	if get_node_or_null("collision") == null:
		var shape := CapsuleShape3D.new()
		shape.radius = 0.25
		shape.height = 1.0
		var col := CollisionShape3D.new()
		col.name = "collision"
		col.shape = shape
		col.position.y = 0.5
		add_child(col)
	var found := find_children("*", "AnimationPlayer", true, false)
	_player = found[0] if not found.is_empty() else null
	if _player != null and not _player.has_animation(move_anim):
		for alt in ["run", "walk", "hop"]:
			if _player.has_animation(alt):
				move_anim = alt
				break


func _physics_process(delta: float) -> void:
	if read_input:
		input_vector = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	tick(delta)


func tick(delta: float) -> void:
	var dir := Vector3(input_vector.x, 0.0, input_vector.y)
	if camera != null:
		# screen-relative controls: forward and right flattened onto the ground plane
		var b := camera.global_transform.basis
		var fwd := Vector3(b.z.x, 0.0, b.z.z).normalized()
		var right := Vector3(b.x.x, 0.0, b.x.z).normalized()
		dir = right * input_vector.x + fwd * input_vector.y
	dir = dir.limit_length(1.0)
	velocity.x = dir.x * speed
	velocity.z = dir.z * speed
	velocity.y = 0.0 if is_on_floor() else velocity.y - 20.0 * delta
	if dir.length() > 0.01:
		# an AstraForge character looks along +Z of its GLB (package contract §4)
		rotation.y = lerp_angle(rotation.y, atan2(dir.x, dir.z), clampf(turn_speed * delta, 0.0, 1.0))
	move_and_slide()
	_play(move_anim if dir.length() > 0.01 else idle_anim)


func _play(anim: String) -> void:
	if anim == current_anim:
		return
	current_anim = anim
	if _player != null and _player.has_animation(anim):
		_player.play(anim, 0.12)
