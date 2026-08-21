from fastapi import FastAPI

app = FastAPI(title="demo-api")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
