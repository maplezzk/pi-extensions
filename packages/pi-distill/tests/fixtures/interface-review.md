# Interface review

## Declaration and implementation
The declaration remains stable while implementation changes.
Location: coding-taste.md:12

## Testability
Must receive dependencies.
Counterexample: new Gateway() inside function.

## Change review
Deep modules expose a small interface.
The interface is the test surface.
Next: check callers and seams.
