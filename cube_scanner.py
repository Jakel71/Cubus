import json
import os

import cv2
import numpy as np
import kociemba

CALIB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cube_calibration.json")

FACE_ORDER = ["U", "R", "F", "D", "L", "B"]

CENTER_LETTER_FOR_FACE = {
    "U": "y",
    "R": "r",
    "F": "b",
    "D": "w",
    "L": "o",
    "B": "g",
}

COLOR_LETTERS = ["w", "y", "r", "o", "g", "b"]

DEFAULT_HSV = {
    "w": np.array([0.0, 18.0, 225.0]),
    "y": np.array([28.0, 200.0, 220.0]),
    "r": np.array([2.0, 215.0, 180.0]),
    "o": np.array([11.0, 225.0, 225.0]),
    "g": np.array([65.0, 190.0, 150.0]),
    "b": np.array([108.0, 205.0, 180.0]),
}

SWATCH_BGR = {
    "w": (235, 235, 235),
    "y": (0, 215, 255),
    "r": (40, 40, 210),
    "o": (0, 140, 255),
    "g": (60, 160, 60),
    "b": (200, 90, 0),
}

GRID_SIZE = 3
CELL_SIZE_PX = 70
CELL_GAP_PX = 10
FRAMES_TO_SMOOTH = 6
MAX_SAMPLES_PER_COLOR = 30


def build_grid(frame_shape):
    frame_h, frame_w = frame_shape[:2]

    grid_span = GRID_SIZE * CELL_SIZE_PX + (GRID_SIZE - 1) * CELL_GAP_PX
    left = frame_w // 2 - grid_span // 2
    top = frame_h // 2 - grid_span // 2

    cells = []
    for row in range(GRID_SIZE):
        for col in range(GRID_SIZE):
            cell_x = left + col * (CELL_SIZE_PX + CELL_GAP_PX)
            cell_y = top + row * (CELL_SIZE_PX + CELL_GAP_PX)
            cells.append((cell_x, cell_y, CELL_SIZE_PX, CELL_SIZE_PX))

    return cells


def read_sticker_hsv(frame, cell):
    cx, cy, cw, ch = cell
    inset = int(cw * 0.3)

    patch = frame[cy + inset:cy + ch - inset, cx + inset:cx + cw - inset]
    if patch.size == 0:
        return np.zeros(3)

    patch = cv2.GaussianBlur(patch, (5, 5), 0)
    pixels = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(np.float32)

    for _ in range(2):
        median_sat = np.median(pixels[:, 1])
        median_val = np.median(pixels[:, 2])

        not_blown_out = pixels[:, 2] < 250
        close_to_median = (np.abs(pixels[:, 1] - median_sat) < 55) & (np.abs(pixels[:, 2] - median_val) < 55)
        keep = not_blown_out & close_to_median

        if keep.sum() < 24:
            break
        pixels = pixels[keep]

    hue_radians = pixels[:, 0] * (np.pi / 90.0)
    sat_weight = pixels[:, 1] + 1.0
    mean_x = float((np.cos(hue_radians) * sat_weight).sum() / sat_weight.sum())
    mean_y = float((np.sin(hue_radians) * sat_weight).sum() / sat_weight.sum())
    mean_hue = (np.arctan2(mean_y, mean_x) % (2 * np.pi)) * (90.0 / np.pi)

    return np.array([mean_hue, float(np.median(pixels[:, 1])), float(np.median(pixels[:, 2]))])


def hue_distance(hue_a, hue_b):
    diff = abs(float(hue_a) - float(hue_b)) % 180.0
    return min(diff, 180.0 - diff)


def hsv_distance(sample, reference):
    hue_gap = hue_distance(sample[0], reference[0]) / 90.0
    shared_saturation = min(sample[1], reference[1]) / 255.0
    sat_gap = abs(sample[1] - reference[1]) / 255.0
    val_gap = abs(sample[2] - reference[2]) / 255.0

    return hue_gap * shared_saturation * 5.0 + sat_gap * 1.2 + val_gap * 0.2


def build_cost_matrix(samples, references):
    return np.array([[hsv_distance(sample, references[letter]) for letter in COLOR_LETTERS] for sample in samples])


def assign_with_quota(samples, references):
    costs = build_cost_matrix(samples, references)
    sticker_count = len(samples)
    remaining = {letter: 9 for letter in COLOR_LETTERS}
    assigned = [None] * sticker_count

    confidence_order = []
    for index in range(sticker_count):
        ranked = np.argsort(costs[index])
        confidence_order.append((costs[index][ranked[1]] - costs[index][ranked[0]], index))
    confidence_order.sort(reverse=True)

    for _, index in confidence_order:
        for letter_index in np.argsort(costs[index]):
            letter = COLOR_LETTERS[letter_index]
            if remaining[letter] > 0:
                assigned[index] = letter
                remaining[letter] -= 1
                break

    swapped_something = True
    while swapped_something:
        swapped_something = False
        for first in range(sticker_count):
            for second in range(first + 1, sticker_count):
                letter_a, letter_b = assigned[first], assigned[second]
                if letter_a == letter_b:
                    continue

                index_a = COLOR_LETTERS.index(letter_a)
                index_b = COLOR_LETTERS.index(letter_b)
                current_cost = costs[first][index_a] + costs[second][index_b]
                swapped_cost = costs[first][index_b] + costs[second][index_a]

                if swapped_cost < current_cost - 1e-9:
                    assigned[first], assigned[second] = letter_b, letter_a
                    swapped_something = True

    return assigned


def weighted_hsv_mean(samples, weights):
    values = np.array(samples, dtype=np.float64)
    weights = np.array(weights, dtype=np.float64)

    hue_radians = values[:, 0] * (np.pi / 90.0)
    hue_weights = weights * (values[:, 1] + 1.0)
    mean_x = (np.cos(hue_radians) * hue_weights).sum() / hue_weights.sum()
    mean_y = (np.sin(hue_radians) * hue_weights).sum() / hue_weights.sum()
    mean_hue = (np.arctan2(mean_y, mean_x) % (2 * np.pi)) * (90.0 / np.pi)

    mean_sat = (values[:, 1] * weights).sum() / weights.sum()
    mean_val = (values[:, 2] * weights).sum() / weights.sum()

    return np.array([mean_hue, mean_sat, mean_val])


def save_calibration(samples_by_color):
    serializable = {letter: [list(map(float, s)) for s in samples] for letter, samples in samples_by_color.items()}
    with open(CALIB_FILE, "w") as f:
        json.dump(serializable, f)


def load_calibration():
    if not os.path.exists(CALIB_FILE):
        return {letter: [] for letter in COLOR_LETTERS}

    with open(CALIB_FILE) as f:
        raw = json.load(f)

    return {letter: [np.array(s, dtype=np.float64) for s in raw.get(letter, [])] for letter in COLOR_LETTERS}


def solve_face_colors(samples, references, known_centers, max_rounds=12):
    references = {letter: hsv.copy() for letter, hsv in references.items()}
    previous_labels = None

    for _ in range(max_rounds):
        labels = assign_with_quota(samples, references)
        if labels == previous_labels:
            break
        previous_labels = labels

        for letter in COLOR_LETTERS:
            matched = [samples[i] for i, label in enumerate(labels) if label == letter]
            weights = [1.0] * len(matched)

            if letter in known_centers:
                matched.append(known_centers[letter])
                weights.append(4.0)

            if matched:
                references[letter] = weighted_hsv_mean(matched, weights)

    return labels, references


def draw_hud(frame, cells, samples, labels, face_index, samples_by_color):
    frame_h, frame_w = frame.shape[:2]

    for cell, label in zip(cells, labels):
        cell_x, cell_y, cell_w, cell_h = cell

        cv2.rectangle(frame, (cell_x, cell_y), (cell_x + cell_w, cell_y + cell_h), (0, 0, 0), 3)
        cv2.rectangle(frame, (cell_x, cell_y), (cell_x + cell_w, cell_y + cell_h), (255, 255, 255), 1)

        swatch_color = SWATCH_BGR[label]
        cv2.rectangle(frame, (cell_x + 4, cell_y + 4), (cell_x + 22, cell_y + 22), swatch_color, -1)
        cv2.rectangle(frame, (cell_x + 4, cell_y + 4), (cell_x + 22, cell_y + 22), (0, 0, 0), 1)

        text_pos = (cell_x + cell_w // 2 - 12, cell_y + cell_h // 2 + 12)
        cv2.putText(frame, label.upper(), text_pos, cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 4)
        cv2.putText(frame, label.upper(), text_pos, cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 1)

    cv2.rectangle(frame, (0, 0), (frame_w, 76), (25, 25, 25), -1)

    if face_index < len(FACE_ORDER):
        face = FACE_ORDER[face_index]
        expected_center = CENTER_LETTER_FOR_FACE[face].upper()
        header = f"Face {face_index + 1}/6: {face}   center must be {expected_center}"
    else:
        header = "All faces captured"

    cv2.putText(frame, header, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (255, 255, 255), 2)
    cv2.putText(
        frame,
        "SPACE capture   u undo   c calibrate face color   r reset   ESC quit",
        (10, 56),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.48,
        (190, 190, 190),
        1,
    )

    for i, letter in enumerate(COLOR_LETTERS):
        swatch_x, swatch_y = 10 + i * 44, frame_h - 54
        sample_count = len(samples_by_color[letter])

        cv2.rectangle(frame, (swatch_x, swatch_y), (swatch_x + 34, swatch_y + 34), SWATCH_BGR[letter], -1)

        border_color = (0, 255, 0) if sample_count else (90, 90, 90)
        cv2.rectangle(frame, (swatch_x, swatch_y), (swatch_x + 34, swatch_y + 34), border_color, 2)

        cv2.putText(frame, letter, (swatch_x + 12, swatch_y + 24), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
        cv2.putText(
            frame, f"x{sample_count}", (swatch_x, swatch_y + 48), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1
        )


def run_scanner():
    camera = cv2.VideoCapture(0)
    if not camera.isOpened():
        raise RuntimeError("Could not open webcam")
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    references = {letter: hsv.copy() for letter, hsv in DEFAULT_HSV.items()}
    samples_by_color = load_calibration()

    for letter, samples in samples_by_color.items():
        if samples:
            references[letter] = weighted_hsv_mean(samples, [1.0] * len(samples))

    total_loaded = sum(len(samples) for samples in samples_by_color.values())
    if total_loaded:
        print(f"Loaded {total_loaded} saved calibration samples from {CALIB_FILE}")

    captured_faces = []
    face_index = 0
    recent_frames = []
    center_cell = GRID_SIZE * GRID_SIZE // 2

    def calibrate(letter, sample):
        samples = samples_by_color[letter]
        samples.append(sample.copy())
        if len(samples) > MAX_SAMPLES_PER_COLOR:
            samples.pop(0)
        references[letter] = weighted_hsv_mean(samples, [1.0] * len(samples))
        save_calibration(samples_by_color)

    while True:
        got_frame, frame = camera.read()
        if not got_frame:
            break
        frame = cv2.flip(frame, 1)

        cells = build_grid(frame.shape)
        this_frame = [read_sticker_hsv(frame, cell) for cell in cells]

        recent_frames.append(this_frame)
        if len(recent_frames) > FRAMES_TO_SMOOTH:
            recent_frames.pop(0)

        smoothed_samples = []
        for cell_index in range(len(cells)):
            history = np.array([frame_samples[cell_index] for frame_samples in recent_frames])
            hue_radians = history[:, 0] * (np.pi / 90.0)
            mean_hue = (np.arctan2(np.sin(hue_radians).mean(), np.cos(hue_radians).mean()) % (2 * np.pi)) * (90.0 / np.pi)
            smoothed_samples.append(np.array([mean_hue, history[:, 1].mean(), history[:, 2].mean()]))

        labels = [min(COLOR_LETTERS, key=lambda letter: hsv_distance(sample, references[letter])) for sample in smoothed_samples]

        draw_hud(frame, cells, smoothed_samples, labels, face_index, samples_by_color)
        cv2.imshow("Cube Scanner", frame)

        key = cv2.waitKey(1) & 0xFF

        if key in (27, ord("q")):
            break

        elif key == ord("r"):
            references = {letter: hsv.copy() for letter, hsv in DEFAULT_HSV.items()}
            samples_by_color = {letter: [] for letter in COLOR_LETTERS}
            save_calibration(samples_by_color)
            captured_faces.clear()
            face_index = 0
            print("Reset")

        elif key == ord("c") and face_index < len(FACE_ORDER):
            letter = CENTER_LETTER_FOR_FACE[FACE_ORDER[face_index]]
            calibrate(letter, smoothed_samples[center_cell])
            hsv = references[letter]
            print(f"Calibrated {letter} ({len(samples_by_color[letter])} samples) -> H{hsv[0]:.0f} S{hsv[1]:.0f} V{hsv[2]:.0f}")

        elif key == ord("u") and captured_faces:
            captured_faces.pop()
            face_index -= 1
            print(f"Undid face, now on {FACE_ORDER[face_index]}")

        elif key == 32 and face_index < len(FACE_ORDER):
            letter = CENTER_LETTER_FOR_FACE[FACE_ORDER[face_index]]
            calibrate(letter, smoothed_samples[center_cell])
            captured_faces.append([sample.copy() for sample in smoothed_samples])
            print(f"Captured {FACE_ORDER[face_index]}")
            face_index += 1
            if face_index >= len(FACE_ORDER):
                print("All faces captured, press ESC to solve")

    camera.release()
    cv2.destroyAllWindows()

    if len(captured_faces) < len(FACE_ORDER):
        print("Scan incomplete")
        return

    all_samples = [sample for face in captured_faces for sample in face]
    known_centers = {
        CENTER_LETTER_FOR_FACE[face]: captured_faces[i][center_cell] for i, face in enumerate(FACE_ORDER)
    }

    sticker_letters, _ = solve_face_colors(all_samples, references, known_centers)
    for i, face in enumerate(FACE_ORDER):
        sticker_letters[i * 9 + center_cell] = CENTER_LETTER_FOR_FACE[face]

    scanned_string = "".join(sticker_letters)
    print(f"\nRaw:  {scanned_string}")
    for i, face in enumerate(FACE_ORDER):
        print(f"  {face}: {''.join(sticker_letters[i * 9:(i + 1) * 9])}")

    cube_string = scanned_string
    for letter, face in [("y", "U"), ("r", "R"), ("b", "F"), ("w", "D"), ("o", "L"), ("g", "B")]:
        cube_string = cube_string.replace(letter, face)
    print(f"Cube: {cube_string}")

    try:
        print(f"Solution: {kociemba.solve(cube_string)}")
    except ValueError as e:
        print(f"Unsolvable, scan has an error: {e}")


if __name__ == "__main__":
    run_scanner()
