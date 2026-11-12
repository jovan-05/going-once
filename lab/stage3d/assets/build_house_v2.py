# v2 house: side walls with wainscot, pilasters and sconces, a proscenium
# frame and an aisle runner. Blender coords: x right, y toward stage, z up.
exec(open(r"C:/Users/Jovan/AppData/Local/Temp/claude/2541094212c80775/28801624-3357-4552-960a-9cf78dca69dc/scratchpad/bhelp.py").read())

def mat(name, rgb, rough=0.85, metal=0.0, emit=None, strength=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = strength
    m.diffuse_color = (*rgb, 1)
    return m

def srgb(h):
    c = [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

mat("Wall", srgb("3A1026"), 0.95)
mat("Lamp", srgb("F6E2C0"), 0.6, emit=srgb("FFD9A0"), strength=3.0)

house = bpy.data.collections.get("House")
if house is None:
    house = bpy.data.collections.new("House")
    SC.collection.children.link(house)
for o in list(house.objects):
    bpy.data.objects.remove(o)

M = ["DarkWood", "Wall", "Brass", "Lamp", "Curtain"]
DW, WALL, BR, LAMP, CUR = range(5)
bm = bmesh.new()
Y0, Y1 = -14.0, 0.95       # audience side of the room
WX = 9.0                   # inner face of the side walls
pil_y = [-11.2, -7.6, -4.0, -0.5]
glows = []
for s in (-1, 1):
    # wall, wainscot, brass chair rail, skirting
    add_box(bm, (0.2, Y1 - Y0, 7.2), (s * (WX + 0.1), (Y0 + Y1) / 2, 3.6), WALL)
    add_box(bm, (0.06, Y1 - Y0, 1.15), (s * (WX - 0.03), (Y0 + Y1) / 2, 0.575), DW, bevel=0.01)
    add_box(bm, (0.08, Y1 - Y0, 0.05), (s * (WX - 0.06), (Y0 + Y1) / 2, 1.17), BR, bevel=0.01)
    for y in pil_y:
        add_box(bm, (0.16, 0.5, 6.4), (s * (WX - 0.08), y, 3.2), DW, bevel=0.02, segs=2)
        add_box(bm, (0.22, 0.62, 0.18), (s * (WX - 0.11), y, 6.4), DW, bevel=0.02)
        # sconce: brass plate + arm + parchment shade
        add_box(bm, (0.04, 0.16, 0.26), (s * (WX - 0.18), y, 2.55), BR, bevel=0.008)
        add_cyl(bm, 0.018, 0.018, 0.18, (s * (WX - 0.27), y, 2.55), BR, segs=8,
                rot=Matrix.Rotation(math.pi / 2, 4, 'Y'))
        add_cyl(bm, 0.13, 0.08, 0.2, (s * (WX - 0.36), y, 2.72), LAMP, segs=16, caps=False)
        glows.append((s * (WX - 0.36), y, 2.72))
    # proscenium pillar
    add_box(bm, (1.7, 0.45, 7.6), (s * 8.15, 0.95, 3.8), DW, bevel=0.03, segs=2)
    add_box(bm, (0.06, 0.47, 7.6), (s * 7.32, 0.95, 3.8), BR, bevel=0.01)
# proscenium header with a brass edge
add_box(bm, (17.6, 0.45, 1.1), (0, 0.95, 7.15), DW, bevel=0.03, segs=2)
add_box(bm, (14.7, 0.47, 0.06), (0, 0.95, 6.6), BR, bevel=0.01)
# aisle runner with thin brass edges, a strong leading line to the lectern
add_box(bm, (1.0, Y1 - 0.25 - Y0, 0.012), (0, (Y0 + Y1 - 0.25) / 2, 0.006), CUR)
for s in (-1, 1):
    add_box(bm, (0.035, Y1 - 0.25 - Y0, 0.016), (s * 0.5, (Y0 + Y1 - 0.25) / 2, 0.008), BR)
ob = finish("House", bm, M, house)
for i, p in enumerate(glows):
    e = bpy.data.objects.new(f"Sconce{i:02d}", None)
    e.empty_display_size = 0.15
    e.location = p
    house.objects.link(e)
result = {"house_faces": len(ob.data.polygons), "sconces": len(glows)}
