# v3 changes on top of the v2 house: 3 rows with a wide aisle, the lectern
# moved right (clear of the centred price), seated silhouettes, front tabs.
import bpy, bmesh, math
from mathutils import Matrix, Vector
exec(open(r"C:/Users/Jovan/AppData/Local/Temp/claude/2541094212c80775/28801624-3357-4552-960a-9cf78dca69dc/scratchpad/build_house_v3.py").read())
room = bpy.data.collections["Room"]
props = bpy.data.collections["Props"]
log = {}

# 1. Fewer rows: drop the two rows farthest from the stage; widen the aisle.
chairs = [o for o in room.objects if o.name.startswith("Chair")]
removed = 0
for o in chairs:
    if o.location.y < -3.5:
        bpy.data.objects.remove(o); removed += 1
for o in [o for o in room.objects if o.name.startswith("Chair")]:
    s = 1 if o.location.x > 0 else -1
    o.location.x = s * (abs(o.location.x) + 1.05)
log["chairs_removed"] = removed

# 2. Lectern (with gavel and block) moves right, out of the price's way.
for n in ("Lectern", "Gavel", "SoundBlock"):
    bpy.data.objects[n].location.x += 1.6

# 3. Front tabs: copies of the main curtains moved to the proscenium, with
#    the origin at the outer edge so scaling x gathers them to the side.
for src, name, edge in (("Curtain_L", "Tab_L", -7.6), ("Curtain_R", "Tab_R", 7.6)):
    old = bpy.data.objects.get(name)
    if old: bpy.data.objects.remove(old)
    me = bpy.data.objects[src].data.copy(); me.name = name
    me.transform(Matrix.Translation((-edge, -4.2, 0)))
    ob = bpy.data.objects.new(name, me); ob.location = (edge, 0, 0)
    room.objects.link(ob)

# 4. Seated silhouette, built relative to the first chair (seat at z 0.49).
mat("Silhouette", srgb("1A0812"), 0.95)
bm = bmesh.new()
add_cyl(bm, 0.19, 0.16, 0.46, (0, -0.03, 0.72), 0, segs=12)              # torso
bmesh.ops.scale(bm, vec=(1, 0.62, 1), verts=[v for v in bm.verts])
sh = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=6, radius=1.0)
bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -0.03, 0.95)) @ Matrix.Diagonal((0.23, 0.13, 0.09, 1)), verts=sh["verts"])
add_cyl(bm, 0.045, 0.045, 0.1, (0, -0.02, 1.05), 0, segs=8)             # neck
hd = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=1.0)
bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -0.01, 1.18)) @ Matrix.Diagonal((0.095, 0.105, 0.115, 1)), verts=hd["verts"])
for f in bm.faces: f.material_index = 0
p = finish("Patron", bm, ["Silhouette"], room, smooth_angle=60)
p.location = bpy.data.objects["Chair"].location.copy()
log["patron_tris"] = sum(len(f.vertices) - 2 for f in p.data.polygons)
log["chairs_left"] = len([o for o in room.objects if o.name.startswith("Chair")])
log["chair_x"] = sorted(set(round(o.location.x, 2) for o in room.objects if o.name.startswith("Chair")))
result = log
