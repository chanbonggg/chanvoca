# Project Context

```json
{
  "mode": "existing",
  "languages": [
    "JavaScript",
    "TypeScript"
  ],
  "frameworks": [
    "next",
    "react"
  ],
  "package_managers": [
    "npm"
  ],
  "test_frameworks": [],
  "frontend": true,
  "backend": false,
  "commands": {
    "lint": {
      "argv": [
        "npm",
        "run",
        "lint"
      ],
      "cwd": "frontend"
    },
    "typecheck": {
      "argv": [
        "npm",
        "run",
        "typecheck"
      ],
      "cwd": "frontend"
    },
    "build": {
      "argv": [
        "npm",
        "run",
        "build"
      ],
      "cwd": "frontend"
    },
    "test": {
      "argv": [
        "npm",
        "run",
        "test"
      ],
      "cwd": "frontend"
    },
    "dev": {
      "argv": [
        "npm",
        "run",
        "dev"
      ],
      "cwd": "frontend"
    },
    "start": {
      "argv": [
        "npm",
        "run",
        "start"
      ],
      "cwd": "frontend"
    }
  },
  "libraries": [
    "postgres"
  ],
  "directories": [
    "backend",
    "docs",
    "frontend"
  ],
  "architecture": "Inspect module boundaries; preserve existing architecture",
  "conventions": "Unconfirmed: naming, error handling, DTO/model, persistence, components. Planner must inspect representative files.",
  "project": {
    "name": "chanvoca",
    "mode": "existing"
  },
  "approved_knowledge": [],
  "agent_roles": []
}
```
