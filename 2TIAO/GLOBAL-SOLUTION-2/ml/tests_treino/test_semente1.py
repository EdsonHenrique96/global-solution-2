"""Confere o CSV da semente 1 (200 episódios) e o modelo treinado com ele (Run treino)."""
import json

import numpy as np

from ml import config
from ml.features import CABECALHO
from ml.treinar import NIVEIS

TRECHOS_COM_PAR = 12


def test_dataset_has_the_door_3_header_and_one_row_per_paired_segment_every_10_s():
    caminho = config.dados_csv()
    with open(caminho, encoding="utf-8") as f:
        assert f.readline() == CABECALHO + "\n"
        linhas = f.read().splitlines()
    assert len(linhas) == 200 * 270 * TRECHOS_COM_PAR
    eps = np.array([int(l.split(";", 1)[0]) for l in linhas])
    assert sorted(set(eps.tolist())) == list(range(1, 201))
    # cada episódio: t_s 10..2700 de 10 em 10, 12 trechos distintos em cada t_s
    primeiro = [l.split(";") for l in linhas[: 270 * TRECHOS_COM_PAR]]
    ts = sorted({int(c[4]) for c in primeiro})
    assert ts == list(range(10, 2701, 10))
    for t in (10, 1350, 2700):
        assert len({c[5] for c in primeiro if int(c[4]) == t}) == TRECHOS_COM_PAR


def test_speed_15_beats_persistence():
    m = json.loads((config.modelos_dir() / "metricas.json").read_text())
    v15 = m["alvos"]["v15"]
    print(f"v15: modelo {v15['mae_modelo']} persistência {v15['mae_persistencia']}")
    assert len(m["episodiosTreino"]) == 160 and len(m["episodiosTeste"]) == 40
    assert v15["mae_modelo"] < v15["mae_persistencia"]


def test_kmeans_of_seed_1_orders_the_four_levels_by_speed():
    k = json.loads((config.modelos_dir() / "kmeans.json").read_text())
    assert [c["nivel"] for c in k["centroides"]] == NIVEIS
    v = [c["centro"][0] * k["desvio"][0] + k["media"][0] for c in k["centroides"]]
    assert v == sorted(v, reverse=True)
