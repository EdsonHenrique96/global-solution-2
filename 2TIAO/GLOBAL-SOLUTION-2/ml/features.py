"""Do CSV de treino (door 3) às amostras do modelo: defasagens de 10 min, uma por minuto (door 2)."""
from __future__ import annotations

import numpy as np
import pandas as pd

CABECALHO = (
    "episodio;semente;dia_semana;hora_min;t_s;trecho;velocidade_kmh;"
    "fluxo_veic_min;densidade_veic_km;ocupacao;acidente"
)
LAGS = 10
PASSO_LINHAS = 6  # uma linha a cada 10 s; uma defasagem por minuto
HORIZONTES = {"15": 90, "30": 180}  # em linhas de 10 s: 15 e 30 min à frente
ALVOS = ["v15", "f15", "v30", "f30"]
SEM_VELOCIDADE = -1.0
COLUNAS_V = [f"v{i}" for i in range(LAGS)]
COLUNAS_F = [f"f{i}" for i in range(LAGS)]
COLUNAS_D = [f"d{i}" for i in range(LAGS)]
FEATURES = ["dia_semana", "hora_min", "trecho_idx", *COLUNAS_V, *COLUNAS_F, *COLUNAS_D]


def carregar(caminho) -> pd.DataFrame:
    with open(caminho, encoding="utf-8") as f:
        primeira = f.readline().rstrip("\n")
    if primeira != CABECALHO:
        raise ValueError(f"cabeçalho diferente da door 3: {primeira!r}")
    return pd.read_csv(caminho, sep=";")


def amostras(df: pd.DataFrame, trechos: list[str]) -> pd.DataFrame:
    """Uma amostra por linha com 10 min de passado: defasagens v, f e d (mais antiga primeiro) e os alvos.

    Velocidade nula vira -1 nas defasagens; o alvo de velocidade fica NaN e a amostra sai do treino dele.
    """
    idx = {t: i for i, t in enumerate(trechos)}
    partes = []
    primeiro = (LAGS - 1) * PASSO_LINHAS
    for (episodio, trecho), g in df.sort_values(["episodio", "trecho", "t_s"]).groupby(["episodio", "trecho"], sort=True):
        v = g["velocidade_kmh"].to_numpy(dtype=float)
        f = np.nan_to_num(g["fluxo_veic_min"].to_numpy(dtype=float), nan=0.0)
        d = np.nan_to_num(g["densidade_veic_km"].to_numpy(dtype=float), nan=0.0)
        n = len(g)
        if n <= primeiro:
            continue
        ancoras = np.arange(primeiro, n)
        lag = ancoras[:, None] - (LAGS - 1 - np.arange(LAGS))[None, :] * PASSO_LINHAS
        vl = np.where(np.isnan(v[lag]), SEM_VELOCIDADE, v[lag])
        bloco = {
            "episodio": episodio,
            "trecho": trecho,
            "trecho_idx": idx.get(trecho, np.nan),
            "dia_semana": g["dia_semana"].to_numpy()[ancoras],
            "hora_min": g["hora_min"].to_numpy()[ancoras],
        }
        for i in range(LAGS):
            bloco[f"v{i}"] = vl[:, i]
            bloco[f"f{i}"] = f[lag[:, i]]
            bloco[f"d{i}"] = d[lag[:, i]]
        for h, passos in HORIZONTES.items():
            alvo = ancoras + passos
            dentro = alvo < n
            vv = np.full(len(ancoras), np.nan)
            ff = np.full(len(ancoras), np.nan)
            vv[dentro] = v[alvo[dentro]]
            ff[dentro] = f[alvo[dentro]]
            bloco[f"v{h}"] = vv
            bloco[f"f{h}"] = ff
        partes.append(pd.DataFrame(bloco))
    return pd.concat(partes, ignore_index=True)


def persistencia(x: pd.DataFrame, alvo: str, media_v: float) -> np.ndarray:
    """Prever o último valor: o último fluxo; a última velocidade medida (sem nenhuma, a média do treino)."""
    if alvo.startswith("f"):
        return x[f"f{LAGS - 1}"].to_numpy(dtype=float)
    vs = x[COLUNAS_V].to_numpy(dtype=float)
    out = np.full(len(vs), media_v)
    for i in range(LAGS):
        out = np.where(vs[:, i] >= 0, vs[:, i], out)
    return out
