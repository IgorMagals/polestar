-- Baked legs (pack format 6; tools/lib/nav/bake.js): the walk into a step,
-- routed offline on the navigation grid and carried by the guide as one
-- string per step (`legs = { [step] = "..." }`). Nav.BakedLeg(step) decodes
-- the current guide's leg into reused arrays for the arrow's follower
-- (Walk.Aim follows it when there is one, else searches as before).
--
--   Nav.BakedLeg(step) -> leg | nil, leg = {
--     c,                         continent (the world position's)
--     n,                         points, 1..n
--     xs, ys, zs,                world yards (x north, y west); zs[i] a height
--     left,                      yards from point i to the goal: left[n] the
--                                last point's distance to the goal
--     cls,                       class of the segment i -> i+1 (1..n-1), as
--                                the grid's: 0 walk, 1 steep, 2 swim, 3 jump,
--                                4 fall, 5 indoor, 6 climb, 7 lift
--     strip, m,                  the ground height every Nav.BAKED_STRIP_YD
--                                along the line, 1..m (the sparkle trail)
--     step, guide,               what it is for
--     id,                        a number that changes with each leg decoded
--                                (the follower resets its state on a new one)
--   }
-- The arrays are reused: the next call with another leg rewrites them, so a
-- caller copies what it keeps. A step without a leg, a leg of another
-- continent or a string that does not read returns nil.
--
-- The string: base-64 digits (A-Z a-z 0-9 + /), each five bits of a varint
-- plus a continuation bit (32), signed values zigzagged: version (1), n;
-- per point dx, dy (0.5 yd) and dz (0.25 yd) from the one before (the first
-- from 0); n-1 classes; the tail (0.25 yd); m and the strip's heights
-- (0.25 yd, the first from point 1's height, then deltas).

local ADDON, ns = ...

local Nav = ns.Nav
local byte, floor = string.byte, math.floor
local sqrt = math.sqrt

Nav.BAKED_STRIP_YD = 2
local QXY, QZ = 0.5, 0.25

local VALUE = {}
do
	local digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	for i = 1, #digits do VALUE[byte(digits, i)] = i - 1 end
end

local leg = { xs = {}, ys = {}, zs = {}, left = {}, cls = {}, strip = {}, n = 0, m = 0 }
local cached -- the string the arrays hold now
local decodes = 0

-- Decode string s into `leg`; false when it does not read.
local function decode(s)
	local pos, len = 1, #s
	local function nextVal()
		local v, mul = 0, 1
		while pos <= len do
			local d = VALUE[byte(s, pos)]
			pos = pos + 1
			if not d then return nil end
			if d >= 32 then
				v = v + (d - 32) * mul
				mul = mul * 32
			else
				return v + d * mul
			end
		end
		return nil
	end
	local function signed()
		local u = nextVal()
		if not u then return nil end
		if u % 2 == 1 then return -(u + 1) / 2 end
		return u / 2
	end
	if nextVal() ~= 1 then return false end
	local n = nextVal()
	if not n or n < 2 then return false end
	local xs, ys, zs, cls, left, strip = leg.xs, leg.ys, leg.zs, leg.cls, leg.left, leg.strip
	local qx, qy, qz = 0, 0, 0
	for i = 1, n do
		local dx, dy, dz = signed(), signed(), signed()
		if not (dx and dy and dz) then return false end
		qx, qy, qz = qx + dx, qy + dy, qz + dz
		xs[i], ys[i], zs[i] = qx * QXY, qy * QXY, qz * QZ
	end
	for i = 1, n - 1 do
		local c = nextVal()
		if not c then return false end
		cls[i] = c
	end
	local tail = nextVal()
	local m = nextVal()
	if not (tail and m) then return false end
	local sz = floor(zs[1] / QZ + 0.5)
	for i = 1, m do
		local d = signed()
		if not d then return false end
		sz = sz + d
		strip[i] = sz * QZ
	end
	-- Yards to the goal from each point, back from the tail.
	left[n] = tail * QZ
	for i = n - 1, 1, -1 do
		local dx, dy, dz = xs[i + 1] - xs[i], ys[i + 1] - ys[i], zs[i + 1] - zs[i]
		left[i] = left[i + 1] + sqrt(dx * dx + dy * dy + dz * dz)
	end
	for i = n + 1, #xs do xs[i], ys[i], zs[i], left[i] = nil, nil, nil, nil end
	for i = n, #cls do cls[i] = nil end
	for i = m + 1, #strip do strip[i] = nil end
	leg.n, leg.m = n, m
	return true
end

-- The current guide's leg into step `step`, decoded; nil without one.
function Nav.BakedLeg(step)
	local E = ns.Engine
	local g = E and E.GetGuide and E.GetGuide()
	local legs = g and rawget(g, "legs")
	local s = type(legs) == "table" and type(step) == "number" and legs[step]
	if type(s) ~= "string" then return nil end
	if s ~= cached then
		cached = nil
		if not decode(s) then return nil end
		cached = s
		decodes = decodes + 1
		leg.id = decodes
	end
	-- The leg's continent: the step's own (its first located goal), as the
	-- compiler placed it; the follower works in the player's.
	local view = E.GetStepView and E.GetStepView(step)
	local c
	for _, gv in ipairs(view and view.goals or {}) do
		if gv.map and gv.x and gv.y then
			c = ns.Compat.MapToWorld(gv.map, gv.x, gv.y, gv.f)
			if c then break end
		end
	end
	leg.c, leg.step, leg.guide = c, step, g.id
	return leg
end
