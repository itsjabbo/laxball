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
| Throw / pass / shoot | Hold **Space**, release to throw. A quick tap is a soft pass; about 1.1 s of holding is a full-power shot. The ring around your player shows the power. |
| Check (knock the ball loose) | **X** or **Shift** |
| Chat | Enter |
| Room menu | Esc |
| Pause (admin) | P |

Your stick points the way you're moving, just like kicking in HaxBall. If you prefer, tick **Aim with mouse** in the room menu: the stick follows the cursor, left click throws (hold to charge) and right click checks.

Type `/avatar 😎` in chat to change your avatar.

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
