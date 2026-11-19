"""`uvicorn ml.api:app --port 8788`: serve a previsão (door 2) e o K-means (door 7) ao painel.

O Vite encaminha `/ml` para cá. Os modelos são relidos quando `metricas.json` muda, então um
treino novo passa a valer sem reiniciar o serviço.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Annotated, Optional

import lightgbm as lgb
import pandas as pd
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import config
from .features import ALVOS, COLUNAS_D, COLUNAS_F, COLUNAS_V, FEATURES, LAGS, SEM_VELOCIDADE

Serie = Annotated[list[float], Field(min_length=LAGS, max_length=LAGS)]
SerieVelocidade = Annotated[list[Optional[float]], Field(min_length=LAGS, max_length=LAGS)]


class Trecho(BaseModel):
    model_config = ConfigDict(extra="forbid")
    v: SerieVelocidade
    f: Serie
    d: Serie


class Entrada(BaseModel):
    """Door 2: diaSemana 0-6 (0 = domingo), horaMin 0-1439, 10 valores por série, do mais antigo ao mais novo."""

    model_config = ConfigDict(extra="forbid")
    diaSemana: int = Field(ge=0, le=6)
    horaMin: int = Field(ge=0, le=1439)
    trechos: dict[str, Trecho]


class Modelos:
    """Os modelos de `modelos_dir()`, recarregados quando `metricas.json` muda."""

    def __init__(self) -> None:
        self._chave: tuple | None = None
        self.metricas: dict | None = None
        self.boosters: dict[str, lgb.Booster] = {}
        self.kmeans: dict | None = None

    def atual(self) -> "Modelos":
        pasta = Path(config.modelos_dir())
        arq = pasta / "metricas.json"
        try:
            chave = (str(pasta), arq.stat().st_mtime_ns)
        except FileNotFoundError:
            self._chave, self.metricas, self.boosters, self.kmeans = None, None, {}, None
            return self
        if chave != self._chave:
            metricas = json.loads(arq.read_text())
            boosters = {a: lgb.Booster(model_file=str(pasta / f"{a}.txt")) for a in ALVOS}
            km = pasta / "kmeans.json"
            self.kmeans = json.loads(km.read_text()) if km.exists() else None
            self.metricas, self.boosters, self._chave = metricas, boosters, chave
        return self


modelos = Modelos()
app = FastAPI(title="transito-ml")


@app.exception_handler(RequestValidationError)
async def entrada_invalida(_req: Request, exc: RequestValidationError) -> JSONResponse:
    detalhe = [f"{'.'.join(str(p) for p in e.get('loc', ()))}: {e.get('msg', '')}" for e in exc.errors()]
    return JSONResponse(status_code=422, content={"erro": "entrada_invalida", "detalhe": detalhe})


def _ausente() -> JSONResponse:
    return JSONResponse(status_code=503, content={"erro": "modelo_ausente"})


@app.get("/ml/saude")
def saude() -> dict:
    m = modelos.atual().metricas
    return {"status": "ok", "modelo": m["versao"] if m else None, "treinadoEm": m["treinadoEm"] if m else None}


@app.get("/ml/kmeans")
def kmeans():
    km = modelos.atual().kmeans
    return km if km else _ausente()


@app.post("/ml/prever")
def prever(entrada: Entrada):
    atual = modelos.atual()
    if not atual.metricas:
        return _ausente()
    indice = {t: i for i, t in enumerate(atual.metricas["trechos"])}
    ids = list(entrada.trechos)
    if not ids:
        return {"modelo": atual.metricas["versao"], "previsoes": {}}
    linhas = []
    for tid in ids:
        t = entrada.trechos[tid]
        linha = {"dia_semana": entrada.diaSemana, "hora_min": entrada.horaMin, "trecho_idx": indice.get(tid, math.nan)}
        for i in range(LAGS):
            v = t.v[i]
            linha[COLUNAS_V[i]] = SEM_VELOCIDADE if v is None or v < 0 else v
            linha[COLUNAS_F[i]] = t.f[i]
            linha[COLUNAS_D[i]] = t.d[i]
        linhas.append(linha)
    x = pd.DataFrame(linhas)[FEATURES]
    pred = {a: atual.boosters[a].predict(x) for a in ALVOS}
    previsoes = {tid: {a: round(float(pred[a][i]), 3) for a in ALVOS} for i, tid in enumerate(ids)}
    return {"modelo": atual.metricas["versao"], "previsoes": previsoes}
