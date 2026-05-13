# Debugging: Diagnostic Snippets

## LP/MILP Diagnostics

### Check Status Properly

```python
# Print actual status value
print(f"Status: '{problem.Status.name}'")

# Common mistake: wrong case
print(f"== 'Optimal': {problem.Status.name == 'Optimal'}")      # ✅
print(f"== 'OPTIMAL': {problem.Status.name == 'OPTIMAL'}")      # ❌ Always False
```

### Inspect Variables

```python
# Check all variable values after solving
for var in problem.getVariables():
    print(f"{var.VariableName} = {var.Value}, ReducedCost = {var.ReducedCost}")

# Or using getter methods
for var in problem.getVariables():
    print(f"{var.getVariableName()}: value={var.getValue()}")

# Check variable bounds and type
for var in problem.getVariables():
    print(f"{var.VariableName}: LB={var.LB}, UB={var.UB}, Type={var.VariableType}")

# Check if integer variables are actually integer
for var in problem.getVariables():
    if var.VariableType == INTEGER:
        val = var.Value
        is_int = abs(val - round(val)) < 1e-6
        print(f"{var.VariableName}: {val} (is_integer: {is_int})")
```

### Inspect Constraints

```python
# Check constraint dual values (LP only)
for c in problem.getConstraints():
    print(f"{c.ConstraintName}: DualValue={c.DualValue}, Slack={c.Slack}")

# Check constraint details
for c in problem.getConstraints():
    print(f"{c.getConstraintName()}: Sense={c.Sense}, RHS={c.RHS}")
```

### Check Problem Size

```python
print(f"Variables: {len(problem.getVariables())}")
print(f"Constraints: {len(problem.getConstraints())}")
```

### Full Problem Summary

```python
def print_problem_summary(problem):
    """Print a summary of the optimization problem."""
    print("=== Problem Summary ===")
    print(f"Variables: {len(problem.getVariables())}")
    print(f"Constraints: {len(problem.getConstraints())}")
    print(f"Status: {problem.Status.name}")
    
    if problem.Status.name in ["Optimal", "FeasibleFound", "PrimalFeasible"]:
        print(f"Objective: {problem.ObjValue}")
        print(f"Solve time: {problem.SolveTime:.4f}s")
        
        print("\n=== Variable Values ===")
        for var in problem.getVariables():
            print(f"  {var.VariableName} = {var.Value}")
```

## Infeasibility Diagnosis

### Check for Conflicting Bounds

```python
# Check if any variable has lb > ub
for var in problem.getVariables():
    if var.LB > var.UB:
        print(f"ERROR: {var.VariableName} has LB={var.LB} > UB={var.UB}")
```

### Print All Constraints

```python
# List all constraints for manual review
print("=== Constraints ===")
for c in problem.getConstraints():
    sense_str = {0: "<=", 1: ">=", 2: "=="}[c.Sense]
    print(f"  {c.ConstraintName}: ... {sense_str} {c.RHS}")
```

## Expression Building (avoid recursion depth)

### Prefer LinearExpression for large expressions

If you hit "maximum recursion depth exceeded" when building objectives or constraints with many terms, avoid chained `+` and use `LinearExpression`:

```python
from cuopt.linear_programming.problem import LinearExpression

vars_list = [x1, x2, x3]  # your variables
coeffs_list = [1.0, 2.0, 3.0]
expr = LinearExpression(vars_list, coeffs_list, constant=0.0)
problem.addConstraint(expr <= 100)
# or problem.setObjective(expr, sense=MINIMIZE)
```

See reference models in this project's assets for full examples.

## Memory Diagnostics

### Check GPU Memory

```python
import subprocess
result = subprocess.run(['nvidia-smi'], capture_output=True, text=True)
print(result.stdout)
```

### Estimate Problem Memory

```python
# Rough estimate for LP/MILP
n_vars = len(problem.getVariables())
n_constraints = len(problem.getConstraints())

# Very rough: constraint matrix dominates
# Assuming ~10 non-zeros per constraint average
nnz_estimate = n_constraints * 10
memory_mb = (nnz_estimate * 8) / 1e6  # 8 bytes per double
print(f"Estimated constraint matrix: ~{memory_mb:.1f} MB")
```

## Performance Diagnostics

### Time the Solve

```python
import time

start = time.time()
problem.solve(settings)
elapsed = time.time() - start
print(f"Wall clock time: {elapsed:.2f}s")
print(f"Solver reported time: {problem.SolveTime:.2f}s")
```

### Enable Solver Logging

```python
from cuopt.linear_programming.solver_settings import SolverSettings

settings = SolverSettings()
settings.set_parameter("log_to_console", 1)
```

### MILP Progress Monitoring

```python
# For long MILP solves, use callbacks to monitor progress
from cuopt.linear_programming.internals import GetSolutionCallback

class ProgressCallback(GetSolutionCallback):
    def __init__(self):
        super().__init__()
        self.count = 0
    
    def get_solution(self, solution, cost):
        self.count += 1
        obj = cost.copy_to_host()[0]
        print(f"Incumbent {self.count}: objective = {obj:.4f}")

settings = SolverSettings()
callback = ProgressCallback()
settings.set_mip_callback(callback)
```

---

## Additional References

| Topic | Resource |
|-------|----------|
| Troubleshooting guide | [NVIDIA cuOpt Docs](https://docs.nvidia.com/cuopt/user-guide/latest/troubleshooting.html) |
| LP/MILP problem | LP/MILP example scripts in the project |