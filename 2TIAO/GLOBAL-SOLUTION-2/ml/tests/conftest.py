import numpy as np
import pytest

from ml.features import CABECALHO

TRECHOS = ["I11>I12", "I12>I13", "I21>I22"]


def csv_sintetico(caminho, episodios=10, semente=3):
    """Episódios de 45 min (270 linhas de 10 s) com 4 regimes de tráfego e velocidade às vezes nula."""
    rng = np.random.RandomState(semente)
    regimes = [(45.0, 3.0, 8.0), (32.0, 7.0, 20.0), (22.0, 11.0, 35.0), (8.0, 4.0, 70.0)]
    linhas = [CABECALHO]
    for ep in range(1, episodios + 1):
        dia = int(rng.randint(0, 7))
        hora = int(rng.randint(0, 1440))
        for k in range(1, 271):
            t = k * 10
            hm = (hora + t // 60) % 1440
            for j, tr in enumerate(TRECHOS):
                reg = regimes[(ep + j + k // 90) % 4]
                v = reg[0] + rng.normal(0, 2)
                f = max(0.0, reg[1] + rng.normal(0, 0.5))
                d = max(0.0, reg[2] + rng.normal(0, 2))
                vs = "" if rng.rand() < 0.05 else f"{v:.4f}"
                acid = 1 if ep % 2 == 1 and 600 <= t < 720 else 0
                linhas.append(f"{ep};{1000 + ep};{dia};{hm};{t};{tr};{vs};{f:.4f};{d:.4f};{int(d / 4)};{acid}")
    caminho.write_text("\n".join(linhas) + "\n")
    return caminho


@pytest.fixture
def csv(tmp_path):
    return csv_sintetico(tmp_path / "metricas.csv")


@pytest.fixture
def modelos(tmp_path, csv, monkeypatch):
    from ml.treinar import treinar

    destino = tmp_path / "modelos"
    treinar(csv, destino)
    monkeypatch.setenv("ML_MODELOS", str(destino))
    return destino
