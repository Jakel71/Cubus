import cv2
import numpy as np

from cube_scanner import (
    CENTER_LETTER_FOR_FACE,
    COLOR_LETTERS,
    FACE_ORDER,
    GRID_SIZE,
    SWATCH_BGR,
    solve_and_report,
)

CELL_PX = 46
CELL_GAP_PX = 3
FACE_GAP_PX = 20
MARGIN = 30

EMPTY_BGR = (70, 70, 70)
LOCKED_BORDER = (0, 200, 0)
UNLOCKED_BORDER = (255, 255, 255)

FACE_GRID_POS = {
    "U": (1, 0),
    "L": (0, 1),
    "F": (1, 1),
    "R": (2, 1),
    "B": (3, 1),
    "D": (1, 2),
}

FACE_PX = GRID_SIZE * CELL_PX + (GRID_SIZE - 1) * CELL_GAP_PX


def face_origin(face):
    col, row = FACE_GRID_POS[face]
    return (
        MARGIN + col * (FACE_PX + FACE_GAP_PX),
        MARGIN + row * (FACE_PX + FACE_GAP_PX),
    )


def build_cells():
    cells = []
    for face in FACE_ORDER:
        origin_x, origin_y = face_origin(face)
        for row in range(GRID_SIZE):
            for col in range(GRID_SIZE):
                index = row * GRID_SIZE + col
                cell_x = origin_x + col * (CELL_PX + CELL_GAP_PX)
                cell_y = origin_y + row * (CELL_PX + CELL_GAP_PX)
                cells.append({"face": face, "index": index, "rect": (cell_x, cell_y, CELL_PX, CELL_PX)})
    return cells


def build_palette(top_y):
    palette = []
    swatch_px = 46
    gap_px = 10
    start_x = MARGIN
    for i, letter in enumerate(COLOR_LETTERS):
        x = start_x + i * (swatch_px + gap_px)
        palette.append({"letter": letter, "rect": (x, top_y, swatch_px, swatch_px)})
    return palette


def point_in_rect(px, py, rect):
    x, y, w, h = rect
    return x <= px < x + w and y <= py < y + h


def initial_board():
    board = {}
    for face in FACE_ORDER:
        for index in range(GRID_SIZE * GRID_SIZE):
            board[(face, index)] = CENTER_LETTER_FOR_FACE[face] if index == 4 else None
    return board


def draw(frame, cells, board, palette, current_color, status_line):
    frame[:] = 30

    for cell in cells:
        x, y, w, h = cell["rect"]
        letter = board[(cell["face"], cell["index"])]
        is_center = cell["index"] == 4

        color = SWATCH_BGR[letter] if letter else EMPTY_BGR
        cv2.rectangle(frame, (x, y), (x + w, y + h), color, -1)

        border = LOCKED_BORDER if is_center else UNLOCKED_BORDER
        cv2.rectangle(frame, (x, y), (x + w, y + h), border, 2 if is_center else 1)

    for face, (col, row) in FACE_GRID_POS.items():
        x, y = face_origin(face)
        cv2.putText(frame, face, (x, y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1)

    for swatch in palette:
        x, y, w, h = swatch["rect"]
        cv2.rectangle(frame, (x, y), (x + w, y + h), SWATCH_BGR[swatch["letter"]], -1)
        selected = swatch["letter"] == current_color
        border = (0, 255, 0) if selected else (120, 120, 120)
        cv2.rectangle(frame, (x, y), (x + w, y + h), border, 3 if selected else 1)

    counts_y = palette[0]["rect"][1] + palette[0]["rect"][3] + 26
    filled_counts = {letter: 0 for letter in COLOR_LETTERS}
    for letter in board.values():
        if letter:
            filled_counts[letter] += 1
    counts_text = "  ".join(f"{letter}:{filled_counts[letter]}/9" for letter in COLOR_LETTERS)
    cv2.putText(frame, counts_text, (MARGIN, counts_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (220, 220, 220), 1)

    help_y = counts_y + 26
    cv2.putText(
        frame,
        "click a swatch to pick a color, click a cell to paint it, right-click clears a cell",
        (MARGIN, help_y),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.45,
        (170, 170, 170),
        1,
    )
    cv2.putText(
        frame,
        "ENTER solve   r reset   ESC quit",
        (MARGIN, help_y + 22),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.45,
        (170, 170, 170),
        1,
    )

    if status_line:
        cv2.putText(frame, status_line, (MARGIN, help_y + 50), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (80, 220, 255), 1)


def try_solve(board):
    letters = []
    for face in FACE_ORDER:
        for index in range(GRID_SIZE * GRID_SIZE):
            letter = board[(face, index)]
            if letter is None:
                return "Fill in every sticker before solving"
            letters.append(letter)

    counts = {letter: letters.count(letter) for letter in COLOR_LETTERS}
    bad_counts = {letter: n for letter, n in counts.items() if n != 9}
    if bad_counts:
        detail = ", ".join(f"{letter}={n}" for letter, n in bad_counts.items())
        return f"Each color needs exactly 9 stickers ({detail})"

    solve_and_report(letters)
    return "Solved - see console output"


def run_manual_entry():
    cells = build_cells()
    board = initial_board()
    current_color = COLOR_LETTERS[0]
    status_line = ""

    palette_top = MARGIN + FACE_PX * 3 + FACE_GAP_PX * 2 + 30
    palette = build_palette(palette_top)

    window = "Cube Manual Entry"
    cv2.namedWindow(window)

    def on_mouse(event, x, y, flags, userdata):
        nonlocal current_color, status_line

        if event == cv2.EVENT_LBUTTONDOWN:
            for swatch in palette:
                if point_in_rect(x, y, swatch["rect"]):
                    current_color = swatch["letter"]
                    return
            for cell in cells:
                if point_in_rect(x, y, cell["rect"]) and cell["index"] != 4:
                    board[(cell["face"], cell["index"])] = current_color
                    status_line = ""
                    return

        elif event == cv2.EVENT_RBUTTONDOWN:
            for cell in cells:
                if point_in_rect(x, y, cell["rect"]) and cell["index"] != 4:
                    board[(cell["face"], cell["index"])] = None
                    status_line = ""
                    return

    cv2.setMouseCallback(window, on_mouse)

    frame_w = MARGIN * 2 + FACE_PX * 4 + FACE_GAP_PX * 3
    frame_h = palette_top + 46 + 90
    frame = np.zeros((frame_h, frame_w, 3), dtype=np.uint8)

    while True:
        draw(frame, cells, board, palette, current_color, status_line)
        cv2.imshow(window, frame)

        key = cv2.waitKey(20) & 0xFF

        if key == 27:
            break
        elif key == ord("r"):
            board = initial_board()
            status_line = "Reset"
        elif key in (13, 10):
            status_line = try_solve(board)

    cv2.destroyAllWindows()


if __name__ == "__main__":
    run_manual_entry()
