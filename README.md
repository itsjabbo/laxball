# LaxBall

A HaxBall-style 2D lacrosse game you host yourself. Every player is a circle with a stick. Scoop up ground balls, catch passes, check the ball loose, and hold Space to wind up a throw — the longer you hold, the harder it goes.

It runs as a small Node.js server (one Docker container) and everyone on your network plays in their browser.

## Run it on the Raspberry Pi

1. Install Docker on the Pi (skip if you already have it):

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER   # then log out and back in
   ```

2. Copy the `laxball` folder to the Pi (USB stick, `scp -r laxball pi@<pi-ip>:~/`, or git) and start it:

   ```bash
   cd ~/laxball
   docker compose up -d --build
   ```

3. Find the Pi's address with `hostname -I`, then open **http://&lt;pi-ip&gt;:7777** in a browser on any computer on the same network.

The container restarts automatically when the Pi reboots.

| Task | Command |
|---|---|
| See logs | `docker compose logs -f` |
| Stop | `docker compose down` |
| Update after editing files | `docker compose up -d --build` |
| Use another port | change `"7777:7777"` to e.g. `"9000:7777"` in `docker-compose.yml` |

Works on 64-bit and 32-bit Raspberry Pi OS (Pi 3, 4, 5). No Docker? Install Node.js 18+ and run `npm install && npm start`.

## How to play

The first person to join is the room admin: they add bots, set the score and time limits, and start the game. Anyone can pick their own team with the Join buttons; the admin can drag players between columns.

| Action | Keys |
|---|---|
| Move | Arrow keys or WASD |
| Aim | Mouse (crosshair). Click the field once to lock the cursor to the game |
| Throw / pass / shoot | Hold **left click** or **Space**, release to throw. A quick tap is a soft pass; about 1.1 s of holding is a full-power shot. The ring around your player shows the power. |
| Check (knock the ball loose) | **Right click**, **X** or **Shift** |
| Chat | **/** opens chat, Enter sends, Esc closes (hidden otherwise; a badge shows unread messages) |
| Fullscreen | **F** (the game also goes fullscreen when you join) |
| Room menu | Esc (also releases the cursor) |
| Pause (admin) | P |

### PS4 / game controller

Plug a PS4 (or Xbox) controller into your computer by USB or Bluetooth and press any button; the room menu shows "Controller connected".

| Control | Button |
|---|---|
| Move | Left stick (push partway to move slower) |
| Aim | Right stick |
| Throw (hold to charge) | R1 |
| Check | L1 |
| Room menu | Options |

Controllers need the game opened over **https** (your `https://…ts.net` address) or `localhost`; browsers block controllers on plain `http://` network addresses.

### Phones and tablets

Open the game on a phone and turn it sideways. Touch anywhere on the **left half** to get a movement joystick under your thumb, and anywhere on the **right half** for an aiming joystick.

- **Shoot / pass:** while you have the ball, drag the aim stick out to the **dashed shoot ring**. It turns yellow and the shot starts charging; let go to throw. The longer you stay out there, the harder the throw. Anywhere inside the dashed ring you can aim and carry the ball without shooting.
- **Check:** **double-tap** anywhere on the right half when you don't have the ball.
- The ☰ button opens the room menu.

### Phone and controller aim settings

Both are in the room menu and saved per browser:

- **Stick aim distance** (phone and controller): how far from your player the crosshair sits when you aim with a stick, from **Close** to **Far** (100% = the faint aim-limit ring). This is the stick version of moving your mouse further away on PC. Default 25%.
- **Phone shoot drag**: how far your thumb must drag the aim stick (60–200 px from where it landed) before a shot starts. Raise it if you shoot by accident while carrying the ball. Default 90 px.

### Stick response

In the room menu, **Stick response** goes from **Smooth** (the original feel: the stick swings round to your aim) to **Instant** (the stick points at your aim the moment you move). It's saved per browser.

Mouse aim is on by default: the stick points at your crosshair, which follows your player and can reach up to half the field's length away (a faint ring shows the limit). Untick **Aim with mouse** in the room menu to play keyboard-only, HaxBall style, where the stick points the way you move.

**Crosshair:** open the room menu (Esc) and expand **Crosshair** to pick a shape (cross, cross + dot, T, X, dot, circle, circle + dot, chevron, square, triangle), a colour, size, thickness, gap, opacity, outline and mouse sensitivity. Settings are saved in your browser. To change the aim limit, edit `AIM_RADIUS_FRAC` near the top of `public/client.js` (0.5 = half the field).

**Ping:** the top-right corner (and the room menu header) shows your round trip to the server, refreshed every 2 seconds: green under 80 ms, yellow under 160 ms, red when it's laggy, and "No response" if the server stops answering.

The game screen itself shows no instructions; all the controls are listed at the bottom of the room menu.

Open chat with `/` and type `/avatar 😎` to change your avatar.

### Rules

- **Catching**: run your stick head into the ball. Very hard throws (near full power) bounce off the stick instead of being caught, so long full-power passes are risky and goalies can knock away hard shots.
- **Checking**: swing at the carrier's stick head to knock the ball loose. Carriers can protect the ball by turning their stick away from the defender. Right after a catch you get a short moment where you can't be checked.
- **Crease**: you can't step into the circle around the goal you are attacking. Defenders may use their own crease, which makes a good goalie spot.
- **Out of bounds**: carrying the ball over the sideline or end line is a turnover.
- **Kickoff**: after a goal, the team that conceded starts with the ball at centre. The other team must stay out of the centre circle until someone touches the ball (same as HaxBall).
- **Overtime**: if time runs out with the score tied, the next goal wins.

## Tweaking

Gameplay numbers live in `server/constants.js` (player speed, throw power range, how long a full charge takes, catch limit, check range, field and goal size). Change them, then run `docker compose up -d --build`.

`node test/sim.js 3 5` plays a 3-on-3 bot match for 5 simulated minutes and prints the stats, which is handy for checking a change.

## Access log

The server writes one JSON line per event to its output: `page`, `connect`, `join`, `team`, `chat`, `game-start`, `game-stop`, `game` (goals, results), `kick`, `disconnect` (with seconds connected). When players arrive through `tailscale serve`, each line includes their Tailscale address and, when Tailscale provides it, their account (`user`).

```bash
sudo docker logs -f laxball                                   # live
sudo docker logs laxball 2>&1 | grep '"ev":"join"'            # who joined
sudo docker logs --since 24h laxball 2>&1 | grep -c '"ev":"connect"'   # connections in the last day
```

Logs are also visible in Portainer under Containers → laxball → Logs.
