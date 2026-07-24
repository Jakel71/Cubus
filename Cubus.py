import kociemba

cube = "rwyrygggobybrrbgoowowybbwwobgyrwbowbyyrbooggrrogwgyyrw"
print(cube)

cube = cube.replace("y", "U")
cube = cube.replace("r", "R")
cube = cube.replace("b", "F")
cube = cube.replace("w", "D")
cube = cube.replace("o", "L")
cube = cube.replace("g", "B")

print(cube)


print(kociemba.solve(cube))
