"""`python -m ml.treinar [--dados CSV] [--modelos DIR]`: treina os 4 LightGBM e o K-means.

Grava em `ml/modelos/`: `v15.txt`, `f15.txt`, `v30.txt`, `f30.txt` (LightGBM), `metricas.json`
(MAE de teste do modelo e da persistência) e `kmeans.json` (door 7). O mesmo CSV dá os mesmos
modelos (RNF06): separação, LightGBM e K-means têm semente fixa.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans

from . import config
from .features import ALVOS, FEATURES, amostras, carregar, persistencia

FRACAO_TREINO = 0.8
SEMENTE = 0
PARAMS = {
    "objective": "regression_l1",
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_data_in_leaf": 50,
    "feature_fraction": 0.9,
    "deterministic": True,
    "force_row_wise": True,
    "num_threads": 4,
    "seed": SEMENTE,
    "verbose": -1,
}
RODADAS = 300

# K-means (door 7, AD-074)
VARIAVEIS = ["velocidade_kmh", "fluxo_veic_min", "densidade_veic_km"]
NIVEIS = ["livre", "moderado", "intenso", "critico"]
VELOCIDADE_VAZIA = 50.0
# a regra única da V1 (AD-047 com AD-080), com a capacidade configurada de cada trecho (AD-087)
CAPACIDADE_CONFIGURADA_VEIC_H = 1940 * 20 / 46
VELOCIDADE_CRITICA = 15.0


def separar_episodios(episodios, fracao=FRACAO_TREINO, semente=SEMENTE):
    """80/20 por episódio: um episódio inteiro fica no treino ou no teste."""
    eps = np.array(sorted(set(int(e) for e in episodios)))
    ordem = np.random.RandomState(semente).permutation(len(eps))
    corte = int(round(len(eps) * fracao))
    return sorted(eps[ordem[:corte]].tolist()), sorted(eps[ordem[corte:]].tolist())


def nivel_da_regra(v: np.ndarray, f: np.ndarray) -> np.ndarray:
    pct = np.round(f * 60 / CAPACIDADE_CONFIGURADA_VEIC_H * 100)
    out = np.where(pct >= 90, "critico", np.where(pct >= 75, "intenso", np.where(pct >= 50, "moderado", "livre")))
    return np.where(~np.isnan(v) & (v < VELOCIDADE_CRITICA), "critico", out)


def treinar_kmeans(df: pd.DataFrame, versao: str) -> dict:
    v = df["velocidade_kmh"].to_numpy(dtype=float)
    f = np.nan_to_num(df["fluxo_veic_min"].to_numpy(dtype=float), nan=0.0)
    d = np.nan_to_num(df["densidade_veic_km"].to_numpy(dtype=float), nan=0.0)
    x = np.column_stack([np.where(np.isnan(v), VELOCIDADE_VAZIA, v), f, d])
    media = x.mean(axis=0)
    desvio = x.std(axis=0)
    desvio[desvio == 0] = 1.0
    z = (x - media) / desvio
    km = KMeans(n_clusters=4, n_init=10, random_state=SEMENTE).fit(z)
    velocidade = km.cluster_centers_[:, 0] * desvio[0] + media[0]
    ordem = np.argsort(-velocidade, kind="stable")
    nivel_do_grupo = {int(g): NIVEIS[i] for i, g in enumerate(ordem)}
    previsto = np.array([nivel_do_grupo[int(g)] for g in km.labels_])
    concordancia = float((previsto == nivel_da_regra(v, f)).mean() * 100)
    return {
        "versao": versao,
        "variaveis": VARIAVEIS,
        "media": [round(float(m), 6) for m in media],
        "desvio": [round(float(s), 6) for s in desvio],
        "centroides": [{"nivel": NIVEIS[i], "centro": [round(float(c), 6) for c in km.cluster_centers_[g]]} for i, g in enumerate(ordem)],
        "concordanciaRegraPct": round(concordancia, 1),
    }


def treinar(caminho_csv: Path, destino: Path) -> dict:
    caminho_csv = Path(caminho_csv)
    destino = Path(destino)
    df = carregar(caminho_csv)
    versao = "v2-" + hashlib.sha256(caminho_csv.read_bytes()).hexdigest()[:12]
    trechos = sorted(df["trecho"].unique().tolist())
    treino_eps, teste_eps = separar_episodios(df["episodio"].unique())
    a = amostras(df, trechos)
    treino = a[a["episodio"].isin(treino_eps)]
    teste = a[a["episodio"].isin(teste_eps)]
    media_v = float(treino.loc[treino["v15"].notna(), "v15"].mean())
    destino.mkdir(parents=True, exist_ok=True)
    alvos = {}
    for alvo in ALVOS:
        tr = treino[treino[alvo].notna()]
        te = teste[teste[alvo].notna()]
        ds = lgb.Dataset(tr[FEATURES], label=tr[alvo], categorical_feature=["trecho_idx"], free_raw_data=False)
        booster = lgb.train(PARAMS, ds, num_boost_round=RODADAS)
        booster.save_model(str(destino / f"{alvo}.txt"))
        pred = booster.predict(te[FEATURES])
        alvos[alvo] = {
            "mae_modelo": round(float(np.mean(np.abs(pred - te[alvo]))), 4),
            "mae_persistencia": round(float(np.mean(np.abs(persistencia(te, alvo, media_v) - te[alvo]))), 4),
            "n_treino": int(len(tr)),
            "n_teste": int(len(te)),
        }
    metricas = {
        "versao": versao,
        "treinadoEm": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "csv": caminho_csv.name,
        "episodiosTreino": treino_eps,
        "episodiosTeste": teste_eps,
        "trechos": trechos,
        "mediaVelocidade": round(media_v, 4),
        "alvos": alvos,
    }
    (destino / "kmeans.json").write_text(json.dumps(treinar_kmeans(df, versao), ensure_ascii=False, indent=2))
    # por último: o serviço só serve um modelo quando metricas.json existe
    (destino / "metricas.json").write_text(json.dumps(metricas, ensure_ascii=False, indent=2))
    return metricas


def main() -> None:
    p = argparse.ArgumentParser(description="Treina o LightGBM e o K-means com o CSV da door 3.")
    p.add_argument("--dados", default=str(config.dados_csv()))
    p.add_argument("--modelos", default=str(config.modelos_dir()))
    args = p.parse_args()
    m = treinar(Path(args.dados), Path(args.modelos))
    for alvo, r in m["alvos"].items():
        print(f"{alvo}: MAE modelo {r['mae_modelo']} · persistência {r['mae_persistencia']} ({r['n_teste']} amostras de teste)")
    print(f"modelos em {args.modelos} (versão {m['versao']})")


if __name__ == "__main__":
    main()
